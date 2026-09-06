// JOBBUS. The Titan Job Bus worker loop (docs/JOB-BUS.md sections 5 and 6). Every dependency the
// loop has is a fake here, so the whole state machine is exercised without a box, an agent or a
// model: health.ping in the host, a dispatched chapter attested against the evidence layer's
// attestation heads, a blocked block, a timeout, a cancel mid-run, and restart recovery.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-worker-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const storeModule = await loadModule("source/host/extensions/job-bus/job-store.ts");
const workerModule = await loadModule("source/host/extensions/job-bus/job-worker.ts");
const { createJobStore } = storeModule.module;
const { buildChapterPrompt, checkClaims, createJobWorker, parseJobBlock, receiptKind } = workerModule.module;

const COMMIT = "3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345";
const ARTIFACT = "notes/c05/02-loops.md";
const chapterPayload = { course_slug: "c05", chapter: 2, repo: "webdevtodayjason/nextgen", branch: "main" };

function resultBlock(body) {
  return `Done.\n\n\`\`\`titan-job-result\n${JSON.stringify(body)}\n\`\`\`\n`;
}
function blockedBlock(body) {
  return `Cannot continue.\n\n\`\`\`titan-job-blocked\n${JSON.stringify(body)}\n\`\`\`\n`;
}
function sendMessage(content, evidence) {
  return { kind: "send-message", message: { type: "text", content }, ...(evidence == null ? {} : { evidence }) };
}

/** A harness whose transcript, agent roster, clock and settings the test moves by hand. */
async function withWorker(run, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-worker-root-"));
  const world = {
    clock: 1_760_000_000_000,
    agents: [{ id: "a1", name: "Scribe", isGroup: false, isRunning: false }],
    entries: [],
    attestations: [],
    prompts: [],
    unread: [],
    settings: {},
    emitted: [],
  };
  const store = createJobStore({
    rootDir: root,
    now: () => world.clock,
    emit: (event) => world.emitted.push(event),
  });
  const worker = createJobWorker({
    store,
    listAgents: () => world.agents,
    sendPrompt: (prompt, agentId) => { world.prompts.push({ prompt, agentId }); },
    readEntries: async () => world.entries,
    readEvidence: async (_agentId, options) => {
      world.lastEvidenceRequest = options;
      return { attestations: world.attestations };
    },
    now: () => world.clock,
    sleep: async () => {},
    readSetting: (name) => world.settings[name],
    markUnread: (agentId) => world.unread.push(agentId),
    ...overrides,
  });
  try { await run({ store, worker, world }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function queueChapter(store, key = "c05-ch2") {
  const { job } = await store.create({
    type: "nextgen.chapter", idempotency_key: key, payload: chapterPayload, submitter: "cos",
  });
  return job;
}

test("the chapter prompt is the contract's, word for word, with the payload filled in", async () => {
  await withWorker(async ({ store }) => {
    const job = await queueChapter(store);
    const prompt = buildChapterPrompt(job);
    assert.equal(prompt.startsWith(`Titan Job Bus job ${job.id} (type nextgen.chapter), submitted by the Chief of Staff.`), true);
    assert.match(prompt, /Payload: course_slug=c05 chapter=2 repo=webdevtodayjason\/nextgen branch=main rules_ref=EXTERNAL-BOT-HANDOFF\.md/);
    assert.match(prompt, /Policy: no_final_assessment=true no_placeholder=true/);
    assert.match(prompt, /Clone or update https:\/\/github\.com\/webdevtodayjason\/nextgen on branch main\./);
    assert.match(prompt, /Do not touch final-assessment material\./);
    assert.match(prompt, /```titan-job-result/);
    assert.match(prompt, /```titan-job-blocked/);
    assert.equal(prompt.trimEnd().endsWith("```"), true);
  });
});

test("no_final_assessment=false drops the final-assessment line and nothing else", async () => {
  await withWorker(async ({ store }) => {
    const { job } = await store.create({
      type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload, policy: { no_final_assessment: false },
    });
    const prompt = buildChapterPrompt(job);
    assert.equal(prompt.includes("final-assessment material"), false);
    assert.match(prompt, /Policy: no_final_assessment=false no_placeholder=true/);
  });
});

test("only the first fenced block is read, and a malformed one is not a block", () => {
  assert.equal(parseJobBlock("nothing here"), null);
  assert.equal(parseJobBlock("```titan-job-result\nnot json\n```"), null);
  const both = `${blockedBlock({ reason: "lms_login", detail: "log in" })}${resultBlock({ summary: "s", commits: [], artifacts: [] })}`;
  assert.equal(parseJobBlock(both).kind, "blocked");
  const parsed = parseJobBlock(resultBlock({ summary: "s", commits: [COMMIT], artifacts: [{ path: ARTIFACT, bytes: 18_000, sha256: "ab" }] }));
  assert.deepEqual(parsed.commits, [COMMIT]);
  assert.deepEqual(parsed.artifacts, [{ path: ARTIFACT, bytes: 18_000, sha256: "ab" }]);
  // An unknown reason is recorded as "other" rather than passed through.
  assert.equal(parseJobBlock(blockedBlock({ reason: "made_up", detail: "d" })).reason, "other");
});

test("the receipt kind comes off the tool name, and mcp is the fallback", () => {
  assert.equal(receiptKind("Shell"), "shell");
  assert.equal(receiptKind("browser_click"), "browser");
  assert.equal(receiptKind("computer_use"), "computer");
  assert.equal(receiptKind("Read"), "read");
  assert.equal(receiptKind("tinyfish__search"), "mcp");
});

test("health.ping finishes in the host, done, with a jobbus receipt from its own audit row", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const { job } = await store.create({ type: "health.ping", idempotency_key: "health-1", payload: {}, submitter: "cos" });
    await worker.tick();
    const done = await store.get(job.id);
    assert.equal(done.status, "done");
    assert.equal(done.result.summary, "pong");
    assert.equal(done.result.attestation.attempt_id, job.id);
    assert.equal(done.result.attestation.receipts.length, 1);
    assert.match(done.result.attestation.receipts[0], /^jobbus:[0-9a-f]{16}$/);
    assert.deepEqual(done.result.attestation.unsupported_claims, []);
    // No agent was touched: the host answered it.
    assert.deepEqual(world.prompts, []);
    assert.deepEqual(world.emitted.map((event) => event.status), ["queued", "running", "done"]);
  });
});

test("a chapter job is dispatched to the named agent with the section 6 prompt", async () => {
  await withWorker(async ({ store, worker, world }) => {
    world.entries = [sendMessage("earlier chatter")];
    const job = await queueChapter(store);
    await worker.tick();
    const running = await store.get(job.id);
    assert.equal(running.status, "running");
    assert.deepEqual(running.worker, { agentId: "a1", agentName: "Scribe", baseline: 1 });
    assert.equal(world.prompts.length, 1);
    assert.equal(world.prompts[0].agentId, "a1");
    assert.equal(world.prompts[0].prompt, buildChapterPrompt(running));
  });
});

test("an agent that is mid-turn leaves the job queued", async () => {
  await withWorker(async ({ store, worker, world }) => {
    world.agents = [{ id: "a1", name: "Scribe", isRunning: true }];
    const job = await queueChapter(store);
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "queued");
    assert.deepEqual(world.prompts, []);
  });
});

test("a worker name that resolves to nothing answers needs_human no_worker", async () => {
  await withWorker(async ({ store, worker, world }) => {
    world.settings.SAND_JOB_BUS_WORKERS = JSON.stringify({ "nextgen.chapter": "Nobody" });
    const job = await queueChapter(store);
    await worker.tick();
    const blocked = await store.get(job.id);
    assert.equal(blocked.status, "needs_human");
    assert.equal(blocked.needs_human.reason, "no_worker");
    assert.match(blocked.needs_human.detail, /Nobody/);
  });
});

test("a second job for the same worker agent waits for the first to finish", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const first = await queueChapter(store, "c05-ch2");
    const second = await queueChapter(store, "c05-ch3");
    await worker.tick();
    assert.equal((await store.get(first.id)).status, "running");
    assert.equal((await store.get(second.id)).status, "queued");
    assert.equal(world.prompts.length, 1);
  });
});

test("an evidenced reply whose claims sit in the attestation heads is done", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    world.entries = [sendMessage(
      resultBlock({ summary: "Course 05 Ch2 notes on main", commits: [COMMIT], artifacts: [{ path: ARTIFACT, bytes: 18_000, sha256: "ab" }] }),
      { verdict: "evidenced", attemptId: "attempt-1", missing: [] },
    )];
    world.attestations = [
      { eventId: "e1", tool: "Shell", head: `${COMMIT}\n` },
      { eventId: "e2", tool: "Shell", head: `18000 ${ARTIFACT}\n` },
    ];
    await worker.tick();

    const done = await store.get(job.id);
    assert.equal(done.status, "done");
    assert.equal(done.result.summary, "Course 05 Ch2 notes on main");
    assert.deepEqual(done.result.commits, [COMMIT]);
    assert.deepEqual(done.result.attestation.receipts, ["shell:e1", "shell:e2"]);
    assert.deepEqual(done.result.attestation.unsupported_claims, []);
    assert.equal(done.result.attestation.attempt_id, "attempt-1");
    // The attestations read are this attempt's, not the conversation's.
    assert.equal(world.lastEvidenceRequest.attemptId, "attempt-1");
  });
});

test("a commit sha in no attestation head fails the job and names the claim", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    world.entries = [sendMessage(
      resultBlock({ summary: "pushed", commits: [COMMIT], artifacts: [{ path: ARTIFACT, bytes: 18_000, sha256: "ab" }] }),
      { verdict: "evidenced", attemptId: "attempt-1", missing: [] },
    )];
    // The artifact is receipted; the sha the model reported is in no head at all.
    world.attestations = [{ eventId: "e1", tool: "Shell", head: `18000 ${ARTIFACT}\n` }];
    await worker.tick();

    const failed = await store.get(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "attestation did not hold");
    // The result rides along so CoS can see exactly which claim went unsupported.
    assert.deepEqual(failed.result.attestation.unsupported_claims, [`commit:${COMMIT}`]);
    assert.deepEqual(failed.result.commits, [COMMIT]);
    assert.deepEqual(failed.result.attestation.receipts, ["shell:e1"]);
  });
});

test("a verdict that is not evidenced makes the summary itself an unsupported claim", () => {
  const checked = checkClaims({ commits: [], artifacts: [], verdict: "unsupported", attestations: [] });
  assert.deepEqual(checked.unsupported_claims, ["summary"]);
  const artifacts = checkClaims({
    commits: [], artifacts: [{ path: ARTIFACT, bytes: 1, sha256: "" }], verdict: "evidenced", attestations: [{ eventId: "e1", tool: "Shell", head: "nothing" }],
  });
  assert.deepEqual(artifacts.unsupported_claims, [`artifact:${ARTIFACT}`]);
  // A short sha in the head still supports the full sha the model reported.
  const short = checkClaims({
    commits: [COMMIT], artifacts: [], verdict: "evidenced", attestations: [{ eventId: "e1", tool: "Shell", head: `commit ${COMMIT.slice(0, 7)} pushed` }],
  });
  assert.deepEqual(short.unsupported_claims, []);
});

test("require_attestation false lets an unsupported claim through, still recorded", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const { job } = await store.create({
      type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload, policy: { require_attestation: false },
    });
    await worker.tick();
    world.entries = [sendMessage(
      resultBlock({ summary: "pushed", commits: [COMMIT], artifacts: [] }),
      { verdict: "unsupported", attemptId: "attempt-1", missing: [] },
    )];
    await worker.tick();
    const done = await store.get(job.id);
    assert.equal(done.status, "done");
    assert.deepEqual(done.result.attestation.unsupported_claims, ["summary", `commit:${COMMIT}`]);
  });
});

test("a blocked block answers needs_human with its reason and marks the agent unread", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    world.entries = [sendMessage(blockedBlock({ reason: "github_auth", detail: "gh auth login on the box" }))];
    await worker.tick();

    const blocked = await store.get(job.id);
    assert.equal(blocked.status, "needs_human");
    assert.deepEqual(blocked.needs_human, { reason: "github_auth", detail: "gh auth login on the box" });
    assert.deepEqual(world.unread, ["a1"]);
    assert.equal(blocked.result, null);
  });
});

test("a job past SAND_JOB_BUS_TIMEOUT_MIN with no reply fails as timed out", async () => {
  await withWorker(async ({ store, worker, world }) => {
    world.settings.SAND_JOB_BUS_TIMEOUT_MIN = "10";
    const job = await queueChapter(store);
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "running");
    // Nine minutes on: still running, the reply may yet arrive.
    world.clock += 9 * 60_000;
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "running");
    world.clock += 2 * 60_000;
    await worker.tick();
    const failed = await store.get(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "timed out");
  });
});

test("cancelling a running job cancels it and tells the agent to stop", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "running");

    const cancelled = await worker.cancel(job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(world.prompts.length, 2);
    assert.equal(world.prompts[1].agentId, "a1");
    assert.match(world.prompts[1].prompt, new RegExp(`Titan Job Bus job ${job.id} was cancelled`));
    assert.match(world.prompts[1].prompt, /Do not commit and do not push\./);
    // A second cancel is the 409 the contract names.
    await assert.rejects(worker.cancel(job.id), (error) => error.status === 409);
  });
});

test("cancelling a queued job needs no prompt at all", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    const cancelled = await worker.cancel(job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(world.prompts, []);
  });
});

test("a job left running by a host restart fails honestly when no result block is there", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    // The host died here. Nothing came back on the transcript.
    await worker.recover();
    const failed = await store.get(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "host restarted mid-job");
  });
});

test("a job left running by a host restart is re-attested when the reply did land", async () => {
  await withWorker(async ({ store, worker, world }) => {
    const job = await queueChapter(store);
    await worker.tick();
    world.entries = [sendMessage(
      resultBlock({ summary: "pushed", commits: [COMMIT], artifacts: [] }),
      { verdict: "evidenced", attemptId: "attempt-1", missing: [] },
    )];
    world.attestations = [{ eventId: "e1", tool: "Shell", head: `${COMMIT}\n` }];
    await worker.recover();
    const done = await store.get(job.id);
    assert.equal(done.status, "done");
    assert.deepEqual(done.result.attestation.receipts, ["shell:e1"]);
  });
});

test("a reply that arrived before the baseline is not this job's reply", async () => {
  await withWorker(async ({ store, worker, world }) => {
    // The same block, already in the conversation before the job was dispatched.
    world.entries = [sendMessage(resultBlock({ summary: "old", commits: [], artifacts: [] }), { verdict: "evidenced", attemptId: "old" })];
    const job = await queueChapter(store);
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "running");
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "running");
  });
});

test("SAND_JOB_BUS_ENABLED=0 idles the loop without touching a single job", async () => {
  await withWorker(async ({ store, worker, world }) => {
    world.settings.SAND_JOB_BUS_ENABLED = "0";
    const job = await queueChapter(store);
    await worker.tick();
    assert.equal((await store.get(job.id)).status, "queued");
    assert.deepEqual(world.prompts, []);
  });
});

test.after(async () => { await storeModule.dispose(); await workerModule.dispose(); });
