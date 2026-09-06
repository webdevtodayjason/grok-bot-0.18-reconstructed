// JOBBUS. The Titan Job Bus store (docs/JOB-BUS.md sections 3, 4, 5, the hardening in 10.1, 10.3
// and 10.5, and the first gate in 9): the allowlist, idempotency (including a replay of a key whose
// job has aged out), payload validation against the section 10.1 patterns, the secret detector, the
// status machine, the chained append-only audit, `maxOpen`, and the 500-terminal-job cap.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
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
const {
  createJobStore,
  findPayloadSecret,
  newJobId,
  validateJobPayload,
  validateJobPolicy,
  verifyJobAuditChain,
  JOB_BODY_MAX_BYTES,
  TERMINAL_JOB_CAP,
} = storeModule.module;

const settingsModule = await loadModule("source/host/extensions/job-bus/job-settings.ts");
const { DEFAULT_JOB_BUS_SETTINGS, createJobSettingsStore } = settingsModule.module;

const REPO = "webdevtodayjason/nextgen-training";
const REPOS = [REPO];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// Section 10.9: the store verifies the record set it reads back, so a hand-seeded jobs.json has to
// carry the payload hash a real record carries. health.ping's payload is `{}`.
const EMPTY_PAYLOAD_SHA = sha256(JSON.stringify({}));

async function withStore(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-root-"));
  const emitted = [];
  const settings = { ...DEFAULT_JOB_BUS_SETTINGS, ...(options.settings ?? {}) };
  let clock = 1_760_000_000_000;
  let counter = 0;
  const store = createJobStore({
    rootDir: root,
    readSettings: () => settings,
    now: () => (clock += 1_000),
    randomHex: (bytes) => String(counter += 1).padStart(bytes * 2, "0"),
    emit: (event) => emitted.push(event),
    ...(options.deps ?? {}),
  });
  try { await run({ store, root, emitted, settings }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function auditLines(root) {
  const raw = await readFile(path.join(root, "job-bus", "audit.jsonl"), "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}
async function auditRows(root) {
  return (await auditLines(root)).map((line) => JSON.parse(line));
}

const chapterPayload = { course_slug: "c05", chapter: 2, repo: REPO, branch: "main" };
const worker = { agentId: "clone1", sourceAgentId: "a1", agentName: "Scribe", baseline: 0, dispatch_nonce: "n1" };

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

// ---- section 10.1 -------------------------------------------------------------------------------

test("every payload field is checked against its pattern, and rules_ref defaults", () => {
  const bad = (patch) => validateJobPayload("nextgen.chapter", { ...chapterPayload, ...patch }, REPOS);
  assert.equal(bad({ chapter: 0 }).ok, false);
  assert.equal(bad({ chapter: 201 }).ok, false);
  assert.equal(bad({ chapter: 1.5 }).ok, false);
  assert.equal(bad({ course_slug: "-nope" }).ok, false);
  assert.equal(bad({ course_slug: "Course05" }).ok, false);
  assert.equal(bad({ course_slug: "a".repeat(82) }).ok, false);
  assert.equal(bad({ repo: "nextgen" }).detail, "repo must be owner/name, neither part starting with -");
  assert.equal(bad({ branch: "main; rm -rf /" }).ok, false);
  assert.equal(bad({ branch: "../main" }).ok, false);
  assert.equal(bad({ rules_ref: "../../etc/passwd" }).ok, false);
  assert.equal(bad({ rules_ref: "/etc/passwd" }).ok, false);
  // Section 10.9. `branch`, `rules_ref` and both halves of `repo` reach a command line in the
  // prompt's step 1 and step 4, and an argument that starts with a dash is an OPTION to git, to gh
  // and to `wc`: `--upload-pack=...`, `--output=...`. The patterns admit no quote, space or
  // newline, so the dash was the one character left that changed what a command does.
  assert.equal(bad({ branch: "--upload-pack=touch /tmp/pwned" }).ok, false);
  assert.equal(bad({ branch: "-main" }).ok, false);
  assert.equal(bad({ rules_ref: "-rf" }).ok, false);
  assert.equal(bad({ repo: "-x/nextgen-training" }).ok, false);
  assert.equal(bad({ repo: "webdevtodayjason/-evil" }).ok, false);
  // A dash anywhere but the front is ordinary, and the allowlisted repo has one.
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, branch: "feature/a-b" }, REPOS).ok, true);
  const good = validateJobPayload("nextgen.chapter", chapterPayload, REPOS);
  assert.equal(good.ok, true);
  assert.equal(good.payload.rules_ref, "EXTERNAL-BOT-HANDOFF.md");
  // health.ping takes no payload at all, and says so rather than dropping what it was handed.
  assert.equal(validateJobPayload("health.ping", { anything: 1 }, REPOS).detail, "unknown field payload.anything");
  assert.deepEqual(validateJobPayload("health.ping", {}, REPOS).payload, {});
});

test("a repo outside the allowlist is refused even when it is well formed", async () => {
  assert.match(validateJobPayload("nextgen.chapter", { ...chapterPayload, repo: "attacker/evil" }, REPOS).detail, /not in the allowlist/);
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: { ...chapterPayload, repo: "attacker/evil" } }),
      (error) => error.status === 400 && error.body.error === "invalid payload" && /not in the allowlist/.test(error.body.detail),
    );
  });
});

// What this proves is the STORE's refusal, over the gateway args object. The other half -- that a
// body posted to /v1 arrives at the store with its unknown field still on it -- is HTTP, and it is
// proved as HTTP in tests/relay-job-bus.test.mjs against this same store rather than a fake.
test("an unknown field in the body, the payload or the policy is a 400 that names it", async () => {
  await withStore(async ({ store }) => {
    const refuses = async (request, detail) => {
      await assert.rejects(
        store.create(request),
        (error) => error.status === 400 && error.body.error === "invalid payload" && error.body.detail === detail,
      );
    };
    await refuses({ type: "health.ping", idempotency_key: "k1", payload: {}, priority: 9 }, "unknown field priority");
    await refuses(
      { type: "nextgen.chapter", idempotency_key: "k2", payload: { ...chapterPayload, extra: 1 } },
      "unknown field payload.extra",
    );
    await refuses(
      { type: "nextgen.chapter", idempotency_key: "k3", payload: chapterPayload, policy: { be_nice: true } },
      "unknown field policy.be_nice",
    );
    await refuses(
      { type: "nextgen.chapter", idempotency_key: "k4", payload: chapterPayload, policy: { no_placeholder: "yes" } },
      "policy.no_placeholder must be a boolean",
    );
  });
});

test("a callback_url is refused, and null or absent is fine", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({ type: "health.ping", idempotency_key: "k1", payload: {}, callback_url: "https://cos.example/hook" }),
      (error) => error.status === 400 && error.body.error === "callbacks are not in v1",
    );
    const created = await store.create({ type: "health.ping", idempotency_key: "k2", payload: {}, callback_url: null });
    assert.equal(created.job.callback_url, null);
  });
});

test("a body over 8 KB is refused at the gateway", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({
        type: "nextgen.chapter",
        idempotency_key: "k1",
        payload: { ...chapterPayload, course_slug: "c".repeat(JOB_BODY_MAX_BYTES) },
      }),
      (error) => error.status === 413 && error.body.error === "job body too large",
    );
  });
});

test("policy defaults to the three the contract prints", async () => {
  assert.deepEqual(validateJobPolicy(undefined).policy, { no_final_assessment: true, no_placeholder: true, require_attestation: true });
  await withStore(async ({ store }) => {
    const plain = await store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload });
    assert.deepEqual(plain.job.policy, { no_final_assessment: true, no_placeholder: true, require_attestation: true });
  });
});

// Section 10.9. `require_attestation:false` turns off both attestation layers, and it used to be
// the bearer holder's to set: anyone who could post a job could have the bus mark it done on the
// model's unchecked word. It is now the operator's, and it lives in the settings file.
test("require_attestation:false is refused unless the operator allowed it on the box", async () => {
  assert.equal(validateJobPolicy({ require_attestation: false }).ok, false);
  assert.equal(validateJobPolicy({ require_attestation: false }).detail, "attestation is required");
  assert.equal(validateJobPolicy({ require_attestation: false }, { allowUnattested: true }).ok, true);
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({
        type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload,
        policy: { require_attestation: false },
      }),
      (error) => error.status === 400 && error.body.error === "attestation is required",
    );
    // The other two policy flags are still the submitter's to set: they narrow the work, they do
    // not turn the checking off.
    const narrowed = await store.create({
      type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload,
      policy: { no_final_assessment: false },
    });
    assert.equal(narrowed.job.policy.no_final_assessment, false);
    assert.equal(narrowed.job.policy.require_attestation, true);
  });
  await withStore(async ({ store }) => {
    const relaxed = await store.create({
      type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload,
      policy: { require_attestation: false },
    });
    assert.equal(relaxed.job.policy.require_attestation, false);
  }, { settings: { allowUnattested: true } });
});

// ---- section 10.3 -------------------------------------------------------------------------------

test("more than maxOpen non-terminal jobs answers 429, and a finished job frees a slot", async () => {
  await withStore(async ({ store }) => {
    const first = await store.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    await store.create({ type: "health.ping", idempotency_key: "k2", payload: {} });
    await assert.rejects(
      store.create({ type: "health.ping", idempotency_key: "k3", payload: {} }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.body.error, "queue full");
        assert.equal(error.body.max_open, 2);
        return true;
      },
    );
    // needs_human is NOT terminal, so it still holds its slot.
    await store.transition(first.job.id, "needs_human", { needs_human: { reason: "approval", detail: "ask" } });
    await assert.rejects(store.create({ type: "health.ping", idempotency_key: "k3", payload: {} }), (error) => error.status === 429);
    await store.cancel(first.job.id);
    assert.equal((await store.create({ type: "health.ping", idempotency_key: "k3", payload: {} })).created, true);
  }, { settings: { maxOpen: 2 } });
});

test("the status machine allows the contract's edges and refuses the rest", async () => {
  await withStore(async ({ store }) => {
    const { job } = await store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload, submitter: "cos" });
    await store.transition(job.id, "running", { worker });
    assert.equal((await store.get(job.id)).started_at != null, true);
    await store.transition(job.id, "done", { result: null });
    // Terminal states refuse, with the 409 the contract names.
    await assert.rejects(store.cancel(job.id), (error) => error.status === 409 && error.body.status === "done");
    // A queued job cancels, and so does one waiting on a human.
    const queued = await store.create({ type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload });
    assert.equal((await store.cancel(queued.job.id)).job.status, "cancelled");
    const blocked = await store.create({ type: "nextgen.chapter", idempotency_key: "k3", payload: chapterPayload });
    await store.transition(blocked.job.id, "needs_human", { needs_human: { reason: "github_auth", detail: "log in" } });
    // Section 10.3: needs_human is not terminal -- it can be cancelled, and it can time out.
    await store.transition(blocked.job.id, "failed", { error: "timed out" });
    // An unknown id is a 404, never a 500.
    await assert.rejects(store.cancel("job_nope"), (error) => error.status === 404 && error.body.error === "job not found");
  });
});

test("setWorker records the clone without writing a second audit row", async () => {
  await withStore(async ({ store, root }) => {
    const { job } = await store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload });
    await store.transition(job.id, "running", { worker: { ...worker, agentId: "" } });
    const before = (await auditRows(root)).length;
    await store.setWorker(job.id, worker);
    assert.equal((await store.get(job.id)).worker.agentId, "clone1");
    assert.equal((await auditRows(root)).length, before);
  });
});

// ---- section 10.5 -------------------------------------------------------------------------------

test("every audit row carries every field, chains to the one before it, and a tampered row breaks it", async () => {
  await withStore(async ({ store, root, emitted }) => {
    const { job } = await store.create({
      type: "health.ping", idempotency_key: "health-1", payload: {}, submitter: "cos",
      submitter_id: "ab12cd34", client: "100.64.0.9",
    });
    await store.transition(job.id, "running", { worker });
    await store.transition(job.id, "failed", {
      error: "timed out", attemptId: "attempt-7", receipts: ["shell:e1"], unsupported_claims: ["summary"],
    });

    const lines = await auditLines(root);
    const rows = lines.map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.event), ["queued", "running", "failed"]);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    assert.equal(rows[0].prev, "");
    for (const [index, row] of rows.entries()) {
      assert.equal(row.jobId, job.id);
      assert.equal(row.type, "health.ping");
      assert.equal(row.submitter, "cos");
      assert.equal(row.submitter_id, "ab12cd34");
      assert.equal(row.client, "100.64.0.9");
      assert.equal(row.idempotency_key, "health-1");
      assert.equal(typeof row.payload_sha256, "string");
      assert.equal(row.policy_version, "v1");
      assert.equal(typeof row.at, "string");
      assert.equal(typeof row.eventId, "string");
      assert.equal("ok" in row, true);
      if (index > 0) assert.equal(row.prev, createHash("sha256").update(lines[index - 1], "utf8").digest("hex"));
    }
    assert.equal(rows[1].worker, "Scribe");
    assert.equal(rows[2].ok, false);
    assert.equal(rows[2].attemptId, "attempt-7");
    assert.deepEqual(rows[2].receipts, ["shell:e1"]);
    assert.deepEqual(rows[2].unsupported_claims, ["summary"]);
    // Receipts are only carried where a transition had them.
    assert.equal("receipts" in rows[1], false);

    assert.deepEqual(await store.verifyAudit(), { ok: true, brokenAt: null, rows: 3 });
    assert.equal(verifyJobAuditChain(lines).ok, true);

    // The whole point of the chain: rewriting a row cannot be hidden, and neither can dropping one.
    const tampered = [...lines];
    tampered[1] = JSON.stringify({ ...rows[1], ok: false });
    assert.deepEqual(verifyJobAuditChain(tampered), { ok: false, brokenAt: 3 });
    assert.deepEqual(verifyJobAuditChain([lines[0], lines[2]]), { ok: false, brokenAt: 2 });

    assert.deepEqual(emitted, [
      { type: "job-bus", jobId: job.id, status: "queued" },
      { type: "job-bus", jobId: job.id, status: "running" },
      { type: "job-bus", jobId: job.id, status: "failed" },
    ]);
    // The audit is append-only: a refused transition writes nothing.
    await assert.rejects(store.transition(job.id, "done", {}));
    assert.equal((await auditLines(root)).length, 3);
  });
});

test("the relay's bearer lockout writes one chained auth_locked row", async () => {
  await withStore(async ({ store, root }) => {
    await store.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    const written = await store.appendExternalAudit({ event: "auth_locked", client: "203.0.113.7" });
    const rows = await auditRows(root);
    assert.equal(rows.at(-1).event, "auth_locked");
    assert.equal(rows.at(-1).client, "203.0.113.7");
    assert.equal(rows.at(-1).jobId, "");
    assert.equal(rows.at(-1).ok, false);
    assert.equal(rows.at(-1).eventId, written.eventId);
    assert.equal((await store.verifyAudit()).ok, true);
  });
});

test("the chain keeps counting after a restart instead of starting again at one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-chain-"));
  try {
    const settings = { ...DEFAULT_JOB_BUS_SETTINGS };
    const first = createJobStore({ rootDir: root, readSettings: () => settings });
    await first.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    const reopened = createJobStore({ rootDir: root, readSettings: () => settings });
    await reopened.create({ type: "health.ping", idempotency_key: "k2", payload: {} });
    const rows = await auditRows(root);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2]);
    assert.equal((await reopened.verifyAudit()).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- the cap and the retired keys ---------------------------------------------------------------

test("jobs.json keeps the newest 500 terminal jobs and never drops a live one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-cap-"));
  try {
    const seeded = [];
    for (let index = 0; index < TERMINAL_JOB_CAP + 5; index += 1) {
      seeded.push({
        id: `job_terminal_${index}`, type: "health.ping", status: "done", idempotency_key: `t${index}`,
        payload: {}, policy: {}, callback_url: null, submitter: "cos", submitter_id: "", client: "",
        payload_sha256: EMPTY_PAYLOAD_SHA, created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z",
        started_at: null, finished_at: null, worker: null, events: [], result: null, error: null, needs_human: null,
      });
    }
    seeded.push({ ...seeded[0], id: "job_live", status: "queued", idempotency_key: "live" });
    await mkdir(path.join(root, "job-bus"), { recursive: true });
    await writeFile(path.join(root, "job-bus", "jobs.json"), JSON.stringify({ jobs: seeded }));

    const store = createJobStore({ rootDir: root, readSettings: () => ({ ...DEFAULT_JOB_BUS_SETTINGS, maxOpen: 100 }) });
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

    // Section 10.3: the pruned keys still answer, with the id and the status they ended on, so a
    // retry of an old key does not start the work a second time.
    const replay = await store.create({ type: "health.ping", idempotency_key: "t0", payload: {} });
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, "job_terminal_0");
    assert.equal(replay.job.status, "done");
    assert.equal((await store.snapshot()).length, kept.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the store survives a restart, and list answers newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-reload-"));
  try {
    const settings = { ...DEFAULT_JOB_BUS_SETTINGS };
    const first = createJobStore({ rootDir: root, readSettings: () => settings });
    const one = await first.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    const two = await first.create({ type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload });
    const reopened = createJobStore({ rootDir: root, readSettings: () => settings });
    const listed = await reopened.list();
    assert.deepEqual(listed.map((job) => job.id), [two.job.id, one.job.id]);
    assert.equal((await reopened.list(1)).length, 1);
    assert.equal(await reopened.queueDepth(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- section 10.7, the settings file -------------------------------------------------------------

test("the bus is off until the operator turns it on, and the file is re-read every time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-settings-"));
  try {
    const settings = createJobSettingsStore(root);
    // No file at all is the defaults, and the default is OFF.
    assert.deepEqual(settings.read(), DEFAULT_JOB_BUS_SETTINGS);
    assert.equal(settings.read().enabled, false);
    assert.equal(settings.settingsPath, path.join(root, "job-bus", "settings.json"));

    const written = await settings.write({ enabled: true, maxOpen: 5 });
    assert.equal(written.enabled, true);
    assert.equal(written.maxOpen, 5);
    // A partial write keeps everything it did not name.
    assert.deepEqual(written.repos, DEFAULT_JOB_BUS_SETTINGS.repos);
    assert.deepEqual(written.allowedConnectors, ["github"]);
    assert.equal(written.timeoutMin, 120);
    assert.equal(written.queueTimeoutMin, 60);

    // Re-read, not cached: an edit made behind the host's back lands without a restart.
    await writeFile(path.join(root, "job-bus", "settings.json"), JSON.stringify({ enabled: true, maxOpen: 9 }));
    assert.equal(settings.read().maxOpen, 9);

    await assert.rejects(
      settings.write({ nope: 1 }),
      (error) => error.status === 400 && error.body.detail === "unknown field nope",
    );
    await assert.rejects(settings.write({ enabled: "yes" }), (error) => error.status === 400);
    await assert.rejects(settings.write({ allowUnattested: "yes" }), (error) => error.status === 400);
    await assert.rejects(settings.write({ maxOpen: 0 }), (error) => error.status === 400);
    // A file that is not JSON at all is the defaults, never a thrown command. On a running host
    // that means the bus goes off, because `enabled` can only be narrowed by the file.
    await writeFile(path.join(root, "job-bus", "settings.json"), "{ not json");
    assert.equal(settings.read().enabled, false);
    assert.equal(settings.read().maxOpen, DEFAULT_JOB_BUS_SETTINGS.maxOpen);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the settings file can narrow what the bus may do, and can never widen it", async () => {
  // Section 10.7's file lives on the box data volume, which is the filesystem the worker agent's
  // own shell runs on. Nothing signs it, so the four fields that widen the bus -- enabled, repos,
  // allowedConnectors and workers -- are the host's copy, moved only by jobBusSetSettings.
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-tamper-"));
  const diverged = [];
  try {
    const settings = createJobSettingsStore(root, { onDivergence: (fields) => diverged.push(fields) });
    await settings.write({ enabled: true, repos: [REPO], allowedConnectors: ["github"] });
    const file = path.join(root, "job-bus", "settings.json");
    const tampered = {
      enabled: true,
      workers: { "nextgen.chapter": "Impostor" },
      repos: [REPO, "attacker/exfil"],
      allowedConnectors: ["github", "slack"],
      timeoutMin: 30,
      queueTimeoutMin: 15,
      maxOpen: 99,
    };
    await writeFile(file, JSON.stringify(tampered));

    const read = settings.read();
    assert.deepEqual(read.repos, [REPO], "a repository the host never held is not in the allowlist");
    assert.deepEqual(read.allowedConnectors, ["github"], "a connector the host never allowed is not allowed");
    assert.deepEqual(read.workers, DEFAULT_JOB_BUS_SETTINGS.workers, "the bus is not repointed by the file");
    // The two clocks and the queue cap are not reach, so section 10.7's re-read still owns them.
    assert.equal(read.timeoutMin, 30);
    assert.equal(read.queueTimeoutMin, 15);
    assert.equal(read.maxOpen, 99);
    assert.deepEqual(diverged, [["repos", "allowedConnectors", "workers"]]);
    // Read again: the same divergence is not a second audit row.
    settings.read();
    assert.equal(diverged.length, 1);

    // Off wins in the other direction: the file can stop a bus it cannot start.
    await writeFile(file, JSON.stringify({ ...tampered, enabled: false }));
    assert.equal(settings.read().enabled, false);
    await settings.write({ enabled: false });
    await writeFile(file, JSON.stringify(tampered));
    const restarted = settings.read();
    assert.equal(restarted.enabled, false, "the file cannot turn the bus back on");
    assert.deepEqual(diverged.at(-1), ["enabled", "repos", "allowedConnectors", "workers"]);

    // The console's own write is the sanctioned path, and it moves the host's copy.
    const widened = await settings.write({ enabled: true, repos: [REPO, "webdevtodayjason/other"] });
    assert.deepEqual(widened.repos, [REPO, "webdevtodayjason/other"]);
    assert.equal(settings.read().enabled, true);
    assert.deepEqual(settings.read().repos, [REPO, "webdevtodayjason/other"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.after(async () => { await storeModule.dispose(); await settingsModule.dispose(); });

// ---- section 10.9: the files are a cache, and the host checks them --------------------------

/** A jobs.json with one believable record in it, written by hand the way a restart would read. */
function seededJob(patch = {}) {
  return {
    id: "job_seeded", type: "health.ping", status: "done", idempotency_key: "seed",
    payload: {}, policy: {}, callback_url: null, submitter: "cos", submitter_id: "", client: "",
    payload_sha256: EMPTY_PAYLOAD_SHA, created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z", started_at: null, finished_at: null, worker: null,
    events: [], result: null, error: null, needs_human: null, ...patch,
  };
}

async function withSeededRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-quarantine-"));
  const directory = path.join(root, "job-bus");
  await mkdir(directory, { recursive: true });
  try { await run({ root, directory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const openStore = (root) => createJobStore({
  rootDir: root,
  readSettings: () => ({ ...DEFAULT_JOB_BUS_SETTINGS, enabled: true, maxOpen: 100 }),
});

test("a jobs.json whose record set does not verify is quarantined and the bus starts disabled", async () => {
  await withSeededRoot(async ({ root, directory }) => {
    // The payload was edited on the volume; its hash was not, and cannot be without the host.
    const tampered = seededJob({ payload: { course_slug: "somebody-elses-course" } });
    await writeFile(path.join(directory, "jobs.json"), JSON.stringify({ jobs: [tampered] }));
    const store = openStore(root);
    const integrity = await store.integrity();
    assert.equal(integrity.ok, false);
    assert.match(integrity.detail, /payload hash/);
    assert.equal((await store.snapshot()).length, 0, "a quarantined store starts empty");
    const moved = (await readdir(directory)).filter((name) => name.startsWith("jobs.json.quarantined-"));
    assert.equal(moved.length, 1, `jobs.json was moved aside: ${moved.join(", ")}`);
    assert.equal((await readdir(directory)).includes("jobs.json"), false);
    // The event is in the same hash chain as everything else the bus did.
    const rows = (await readFile(path.join(directory, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).event, "store_quarantined");
    assert.equal(rows.at(-1).ok, false);
    assert.equal(verifyJobAuditChain(rows.map((row) => JSON.stringify(row))).ok, true);
  });
});

test("a jobs.json that is not JSON at all is quarantined the same way; an absent one is not", async () => {
  await withSeededRoot(async ({ root, directory }) => {
    await writeFile(path.join(directory, "jobs.json"), "not json, not even close");
    const store = openStore(root);
    assert.equal((await store.integrity()).ok, false);
    assert.equal((await readdir(directory)).some((name) => name.startsWith("jobs.json.quarantined-")), true);
  });
  // A box that has never run a job has no jobs.json, and that is a first start, not a tamper.
  await withSeededRoot(async ({ root, directory }) => {
    const store = openStore(root);
    assert.equal((await store.integrity()).ok, true);
    assert.equal((await readdir(directory)).some((name) => name.startsWith("jobs.json.quarantined-")), false);
  });
});

test("a broken audit chain quarantines the job store too, because the receipt is what jobs.json is checked against", async () => {
  await withSeededRoot(async ({ root, directory }) => {
    await writeFile(path.join(directory, "jobs.json"), JSON.stringify({ jobs: [seededJob()] }));
    // Two rows whose `prev` does not chain: the second was edited after it was written.
    const row = (seq, prev, eventId) => JSON.stringify({
      seq, prev, at: "2026-09-05T00:00:00.000Z", event: "queued", jobId: "job_seeded", type: "health.ping",
      submitter: "cos", submitter_id: "", client: "", idempotency_key: "seed", payload_sha256: EMPTY_PAYLOAD_SHA,
      policy_version: "v1", worker: null, ok: true, eventId,
    });
    await writeFile(path.join(directory, "audit.jsonl"), `${row(1, "", "aa")}\n${row(2, "0".repeat(64), "bb")}\n`);
    const store = openStore(root);
    const integrity = await store.integrity();
    assert.equal(integrity.ok, false);
    assert.match(integrity.detail, /audit chain breaks at row 2/);
    assert.equal((await store.snapshot()).length, 0);
  });
});

test("audit.jsonl rewritten under the host is caught by the length the host remembers", async () => {
  await withSeededRoot(async ({ root, directory }) => {
    const store = openStore(root);
    const first = await store.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    const before = (await readFile(path.join(directory, "audit.jsonl"), "utf8")).trim().split("\n");
    assert.equal(before.length, 1);
    // A whole-file rewrite: consistent rows, consistent hashes. The chain alone verifies it, which
    // is exactly the hole -- the log lives on the volume the worker's own shell can write.
    const forged = JSON.stringify({
      ...JSON.parse(before[0]), jobId: "job_somebody_elses", idempotency_key: "not-what-happened",
    });
    await writeFile(path.join(directory, "audit.jsonl"), `${forged}\n`);
    assert.equal(verifyJobAuditChain([forged]).ok, true, "the forged file passes the chain check");
    // The host has been extending this file and knows what it left behind.
    await store.transition(first.job.id, "cancelled");
    const rows = (await readFile(path.join(directory, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[0].event, "store_quarantined", "the fresh chain opens with the break");
    assert.match(String(rows[0].unsupported_claims?.[0] ?? ""), /audit\.jsonl changed under the host/);
    assert.equal((await readdir(directory)).some((name) => name.startsWith("audit.jsonl.quarantined-")), true);
  });
});

test("a store that cannot be written fails the transition and says so in the audit", async () => {
  await withSeededRoot(async ({ root, directory }) => {
    const store = openStore(root);
    const created = await store.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    // jobs.json is replaced by a directory, so every later write of it throws. A swallowed error
    // here is how a queued job gets dispatched twice: the host believes a dispatch it never wrote.
    await rm(path.join(directory, "jobs.json"));
    await mkdir(path.join(directory, "jobs.json"));
    await assert.rejects(
      store.transition(created.job.id, "running"),
      (error) => error.status === 503 && error.body.error === "the job store could not be written",
    );
    const rows = (await readFile(path.join(directory, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).event, "store_unwritable");
    assert.equal(rows.at(-1).jobId, created.job.id);
    assert.equal(verifyJobAuditChain(rows.map((row) => JSON.stringify(row))).ok, true);
  });
});

test("a replay of a pruned key answers with the created_at the job really had", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-retired-"));
  try {
    const seeded = [];
    for (let index = 0; index < TERMINAL_JOB_CAP + 1; index += 1) {
      seeded.push(seededJob({
        id: `job_terminal_${index}`, idempotency_key: `t${index}`,
        created_at: `2026-09-05T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      }));
    }
    await mkdir(path.join(root, "job-bus"), { recursive: true });
    await writeFile(path.join(root, "job-bus", "jobs.json"), JSON.stringify({ jobs: seeded }));
    const store = openStore(root);
    await store.create({ type: "health.ping", idempotency_key: "fresh", payload: {} });
    const replay = await store.create({ type: "health.ping", idempotency_key: "t0", payload: {} });
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, "job_terminal_0");
    // The create answer is four fields and this is one of them: "" told CoS the job it already had
    // was made at no time at all.
    assert.equal(replay.job.created_at, "2026-09-05T00:00:00.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings.json is quarantined at start when it is there and cannot be believed", async () => {
  // Section 10.9's other half. The file sits on the volume the worker's own shell can write, so the
  // host checks it before it believes it -- and a file that is unreadable at START is not the same
  // as one that is absent, which is an ordinary first boot.
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-settings-quarantine-"));
  try {
    const directory = path.join(root, "job-bus");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "settings.json"), "{ enabled: true, but not JSON");
    const seen = [];
    const settings = createJobSettingsStore(root, { onQuarantine: (record) => seen.push(record) });
    assert.equal(seen.length, 1);
    assert.equal(settings.quarantined()?.movedTo, seen[0].movedTo);
    assert.match(seen[0].detail, /not JSON/);
    // The defaults, which means the bus is OFF.
    assert.equal(settings.read().enabled, false);
    assert.equal(settings.read().allowUnattested, false);
    const moved = (await readdir(directory)).filter((name) => name.startsWith("settings.json.quarantined-"));
    assert.equal(moved.length, 1, `settings.json was moved aside: ${moved.join(", ")}`);
    assert.equal((await readdir(directory)).includes("settings.json"), false);
  } finally { await rm(root, { recursive: true, force: true }); }

  // An absent file quarantines nothing and reports nothing.
  const fresh = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-settings-fresh-"));
  try {
    const seen = [];
    const settings = createJobSettingsStore(fresh, { onQuarantine: (record) => seen.push(record) });
    assert.deepEqual(seen, []);
    assert.equal(settings.quarantined(), null);
    assert.deepEqual(settings.read(), DEFAULT_JOB_BUS_SETTINGS);
  } finally { await rm(fresh, { recursive: true, force: true }); }
});

test("allowUnattested is guarded like enabled: the file may turn it off, never on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-unattested-"));
  const diverged = [];
  try {
    const settings = createJobSettingsStore(root, { onDivergence: (fields) => diverged.push(fields) });
    await settings.write({ enabled: true, allowUnattested: false });
    const file = path.join(root, "job-bus", "settings.json");
    // A shell in the box turning the attestation off would be the whole point of turning it off.
    await writeFile(file, JSON.stringify({ ...settings.read(), allowUnattested: true }));
    assert.equal(settings.read().allowUnattested, false);
    assert.deepEqual(diverged.at(-1), ["allowUnattested"]);
    // The operator's own command moves it, and then the file agrees with the host.
    await settings.write({ allowUnattested: true });
    assert.equal(settings.read().allowUnattested, true);
    // And the file can still narrow it back off without a divergence row.
    const rows = diverged.length;
    await writeFile(file, JSON.stringify({ ...settings.read(), allowUnattested: false }));
    assert.equal(settings.read().allowUnattested, false);
    assert.equal(diverged.length, rows);
  } finally { await rm(root, { recursive: true, force: true }); }
});
