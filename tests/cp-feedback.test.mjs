// FEEDBACK-1. The report channel: the payload's shape, the intake's two rules, the panel's states,
// the issue door, and the ceiling control that rides in beside it (AGENTS-CAP-2).
//
// The two rules the intake exists to keep, and each has a test here that would have caught it
// breaking: the workspace comes from the RELAY's forwarded header and never from the body, so a box
// cannot file as its neighbour; and the credential is CP_RELAY_TOKEN, deliberately not the admin
// token, so the two doors stay separate the way the registry route's do.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { openStore, FEEDBACK_STATES, SECRET_SETTINGS } from "../cp/store.mjs";
import {
  FEEDBACK_TIERS,
  INTAKE_BYTES,
  LIMITS,
  buildDigest,
  buildIssueBody,
  fileIssue,
  normalizeReport,
  parseRepo,
  proveRepoToken,
} from "../cp/feedback.mjs";
import { createAdminApi } from "../cp/admin.mjs";
import { makeTempRoot, startControlPlane } from "./cp-support.mjs";

async function withStore(run) {
  const root = await makeTempRoot("cp-feedback-");
  const store = openStore({ dataDir: root });
  try { await run(store, root); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

const REPORT = {
  version: 1,
  tier: "critical",
  category: "tools",
  title: "The browser tool answered 500 four times in a row",
  description: "Every attempt to open a page failed and I could not finish the task.",
  steps: ["Ask Titan to read a page", "Watch the tool fail", "Ask again"],
  tools: [{ name: "openPage", status: "failed", error: "500 from the box" }],
  evidence: {
    agent: "agent-7",
    agentName: "Titan",
    conversation: "conv-3",
    hostVersion: "0.18.4",
    consoleVersion: "2026-09-09",
    calls: [{ name: "openPage", status: "500", summary: "the box refused", output: "Internal error" }],
    messages: [{ role: "assistant", text: "I could not open that page." }],
  },
};

// ---- the payload -------------------------------------------------------------------------------

test("a report keeps what it knows, clamps it, and drops everything else", () => {
  const normalized = normalizeReport({
    ...REPORT,
    title: `${"x".repeat(LIMITS.title + 50)}`,
    description: "y".repeat(LIMITS.description),
    steps: Array.from({ length: LIMITS.steps }, (_, i) => `step ${i}`),
    // Nothing takes a workspace from a body, so an attempt to name one is simply not kept.
    workspace: "somebody-else",
    slug: "somebody-else",
    // An unknown key is not an error and is not stored: a report is evidence, not a document
    // somebody gets to design.
    surprise: { deeply: { nested: "thing" } },
  });
  assert.equal(normalized.ok, true);
  const report = normalized.report;
  assert.equal(report.title.length, LIMITS.title, "the title is one line and clamped");
  assert.equal(report.description.length, LIMITS.description);
  assert.equal(report.steps.length, LIMITS.steps);
  assert.equal(report.surprise, undefined, "an unknown key is dropped");
  assert.equal(report.slug, undefined);
  assert.equal(report.evidence.workspace, "", "the workspace is left for the intake to stamp");
  assert.equal(report.version, 1);
});

test("a tier that is not one of the three is refused in a sentence, never guessed", () => {
  for (const tier of ["urgent", "", "CRITICAL ", null]) {
    const normalized = normalizeReport({ ...REPORT, tier });
    if (tier === "CRITICAL ") {
      assert.equal(normalized.ok, true, "case and whitespace are forgiven, because the tool writes it");
      continue;
    }
    assert.equal(normalized.ok, false, `${String(tier)} was accepted`);
    assert.match(normalized.why, /tier has to be one of/);
  }
  assert.deepEqual(FEEDBACK_TIERS, ["critical", "quality", "observation"]);
});

test("a report with no title and one with no description are both refused", () => {
  assert.equal(normalizeReport({ ...REPORT, title: "   " }).ok, false);
  assert.equal(normalizeReport({ ...REPORT, description: "" }).ok, false);
  assert.equal(normalizeReport("not an object").ok, false);
});

const atEveryLimit = () => ({
  tier: "quality",
  category: "x".repeat(LIMITS.category),
  title: "t".repeat(LIMITS.title),
  description: "d".repeat(LIMITS.description),
  steps: Array.from({ length: LIMITS.steps }, () => "s".repeat(LIMITS.step)),
  tools: Array.from({ length: LIMITS.tools }, (_, i) => ({ name: `tool${i}`, status: "failed", error: "e".repeat(LIMITS.toolError) })),
  evidence: {
    calls: Array.from({ length: LIMITS.calls }, (_, i) => ({ name: `call${i}`, status: "500", summary: "s".repeat(LIMITS.callSummary), output: "o".repeat(LIMITS.callOutput) })),
    messages: Array.from({ length: LIMITS.messages }, () => ({ role: "assistant", text: "m".repeat(LIMITS.messageText) })),
  },
});

test("a report at every limit at once still fits the intake", () => {
  const big = normalizeReport(atEveryLimit());
  assert.equal(big.ok, true);
  const bytes = Buffer.byteLength(JSON.stringify(big.report), "utf8");
  // The whole point of the limits: a console that mints inside them always lands, so nobody ever
  // sees a report truncated into one that reads as complete and is not. The envelope needs room,
  // so a maximal report has to leave a few KB of the intake unused.
  assert.ok(bytes < INTAKE_BYTES - 4096, `a maximal report is ${bytes} bytes, which does not fit the ${INTAKE_BYTES} byte intake`);
});

// The fault this pins: the intake used to keep 8,000 characters of a 15,296-character description,
// drop two of the twelve calls the console mints and cut each call's output from 1,200 to 800 --
// and answer 201, with nothing on any screen saying so. A report is refused now, never shortened.
test("a report over a limit is refused with the field named, and nothing is shortened", () => {
  const over = (patch) => normalizeReport({ ...atEveryLimit(), ...patch });

  const longDescription = over({ description: "d".repeat(LIMITS.description + 1) });
  assert.equal(longDescription.ok, false, "a description over the limit was accepted and cut");
  assert.match(longDescription.why, /the description is \d+ characters/);
  assert.match(longDescription.why, /Nothing was stored/);

  const shape = atEveryLimit();
  const tooManyCalls = over({
    evidence: { ...shape.evidence, calls: [...shape.evidence.calls, { name: "one-more", status: "500", summary: "s", output: "o" }] },
  });
  assert.equal(tooManyCalls.ok, false, "a thirteenth call was dropped instead of refused");
  assert.match(tooManyCalls.why, /13 recorded calls/);

  const longOutput = over({
    evidence: { ...shape.evidence, calls: [{ name: "Shell", status: "failed", summary: "s", output: "o".repeat(LIMITS.callOutput + 1) }] },
  });
  assert.equal(longOutput.ok, false, "an output over the limit was accepted and cut");
  assert.match(longOutput.why, /what Shell printed/);

  // The cosmetic one-liners are the exception and stay clamped: the person cannot edit a title on
  // the card, so refusing one would leave them holding a report they had no way to send.
  const longTitle = over({ title: "t".repeat(LIMITS.title + 40) });
  assert.equal(longTitle.ok, true);
  assert.equal(longTitle.report.title.length, LIMITS.title);
});

// The console's own maximum shape, minted the way ui/machine-room/app.js mints it: twelve calls
// with a 400-character summary and a 1,200-character output, six messages of 800, and a body that
// carries all of it plus the agent's own words. Nothing may be shorter after the intake.
test("the console's maximum report lands with nothing shorter than it was sent", () => {
  const calls = Array.from({ length: 12 }, (_, i) => ({
    name: `Shell`, status: "failed", summary: `run ${i} `.padEnd(400, "."), output: `output ${i} `.padEnd(1200, "."),
  }));
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "you" : "agent", text: `said ${i} `.padEnd(800, ".") }));
  const bodyLines = [
    "The shell has failed every time for the last hour.",
    "", "What ran just before:",
    ...calls.map((call) => `- ${call.summary}\n  ${call.output}`),
    "", "Last said:",
    ...messages.map((message) => `- ${message.role}: ${message.text}`),
  ];
  const description = bodyLines.join("\n");
  const sent = {
    tier: "critical", category: "shell", title: "The shell refuses every command",
    description,
    tools: [{ name: "Shell", status: "failed", error: "exit 1" }],
    evidence: { agent: "titan", agentName: "Titan", conversation: "titan", hostVersion: "1", consoleVersion: "2", calls, messages },
  };
  const normalized = normalizeReport(sent);
  assert.equal(normalized.ok, true, `the console's own maximum was refused: ${normalized.why}`);
  const report = normalized.report;
  assert.equal(report.description.length, description.length, "the description came back shorter than it was sent");
  assert.equal(report.evidence.calls.length, calls.length, "calls were dropped");
  report.evidence.calls.forEach((call, i) => {
    assert.equal(call.output.length, calls[i].output.length, `call ${i} output was cut`);
    assert.equal(call.summary.length, calls[i].summary.length, `call ${i} summary was cut`);
  });
  assert.equal(report.evidence.messages.length, messages.length, "messages were dropped");
  report.evidence.messages.forEach((message, i) => assert.equal(message.text.length, messages[i].text.length, `message ${i} was cut`));
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") < INTAKE_BYTES);
});

test("the issue body carries the evidence and no fence escapes the page", () => {
  const body = buildIssueBody(normalizeReport(REPORT).report, { workspace: "demo", id: 12 });
  assert.match(body, /demo/);
  assert.match(body, /openPage/);
  assert.match(body, /Internal error/);
  assert.match(body, /Feedback id \| 12/);
  // A stack trace with a fence in it must not end the fence early and turn the rest into headings.
  const withFence = buildIssueBody(normalizeReport({
    ...REPORT,
    evidence: { ...REPORT.evidence, calls: [{ name: "x", status: "500", summary: "", output: "```\nnot a fence\n```" }] },
  }).report, { workspace: "demo" });
  assert.equal(/\n```\nnot a fence/.test(withFence), false, "a fence in the evidence closed the block");
});

test("owner/name is parsed and anything else is a typo that never becomes a request", () => {
  assert.equal(parseRepo("acme/widgets").full, "acme/widgets");
  for (const bad of ["acme", "acme/widgets/extra", "acme /widgets", "", "https://github.com/acme/widgets"]) {
    assert.equal(parseRepo(bad), null, `${bad} was accepted`);
  }
});

test("the digest batches by workspace and says so when there is nothing", () => {
  const empty = buildDigest([], { tier: "quality", since: 0 });
  assert.match(empty, /Nothing in this window/);
  assert.equal(/0 report/.test(empty), false, "an empty window reads as an answer, not as a zero");
  const text = buildDigest([
    { id: 1, at: 1000, tenant: "demo", tier: "quality", state: "new", title: "one", issueUrl: "" },
    { id: 2, at: 2000, tenant: "demo", tier: "quality", state: "new", title: "two", issueUrl: "" },
    { id: 3, at: 3000, tenant: "acme", tier: "critical", state: "new", title: "three", issueUrl: "" },
  ], { tier: "quality", since: 0, now: 5000 });
  assert.match(text, /2 reports from 1 workspace/);
  assert.equal(/three/.test(text), false, "a different tier is not in this tier's digest");
});

// ---- the store ---------------------------------------------------------------------------------

test("a report is stored, listed by every filter, and moved through its states", async () => {
  await withStore((store) => {
    const first = store.recordFeedback({ tenant: "demo", tier: "critical", title: "one", body: "b", payload: REPORT });
    store.recordFeedback({ tenant: "demo", tier: "quality", title: "two", body: "b", payload: {} });
    store.recordFeedback({ tenant: "acme", tier: "quality", title: "three", body: "b", payload: {} });
    assert.equal(store.countFeedback(), 3);
    assert.equal(store.listFeedback({ tier: "quality" }).length, 2);
    assert.equal(store.listFeedback({ tenant: "acme" }).length, 1);
    assert.equal(store.listFeedback({ state: "new" }).length, 3);
    // The payload comes back parsed, because every caller wants the object.
    assert.equal(store.getFeedback(first.id).payload.evidence.agentName, "Titan");
    const approved = store.updateFeedback(first.id, { state: "approved", decidedBy: "boss@example.com" });
    assert.equal(approved.state, "approved");
    assert.ok(approved.decidedAt > 0);
    assert.equal(store.listFeedback({ state: "new" }).length, 2);
    assert.throws(() => store.updateFeedback(first.id, { state: "pending" }), /state has to be one of/);
    assert.deepEqual(FEEDBACK_STATES, ["new", "approved", "filed", "suppressed", "closed"]);
  });
});

test("a report too big for the table is refused rather than cut in half", async () => {
  await withStore((store) => {
    // Cut in half it would read as a whole report and send whoever read it looking for a step that
    // was never written down.
    assert.throws(() => store.recordFeedback({ tenant: "demo", tier: "quality", title: "x", body: "y".repeat(300 * 1024) }), /has to fit/);
    assert.equal(store.countFeedback(), 0);
  });
});

test("a payload that will not parse still lists as a report", async () => {
  await withStore((store) => {
    const row = store.recordFeedback({ tenant: "demo", tier: "quality", title: "x", body: "y", payload: "{not json" });
    assert.equal(row.payload, null, "the evidence is unreadable");
    assert.equal(row.title, "x", "and the report is still a report");
  });
});

test("the GitHub token comes back from listSettings with no value at all", async () => {
  await withStore((store) => {
    const planted = `ghp_${randomBytes(20).toString("hex")}`;
    store.setSetting("github.token", planted, "boss@example.com");
    store.setSetting("github.repo", "acme/widgets", "boss@example.com");
    assert.ok(SECRET_SETTINGS.has("github.token"));
    const listed = store.listSettings();
    assert.equal(JSON.stringify(listed).includes(planted), false, "listSettings carried the token");
    const token = listed.find((row) => row.name === "github.token");
    assert.equal(token.value, "");
    assert.equal(token.redacted, true);
    assert.equal(listed.find((row) => row.name === "github.repo").redacted, false, "an ordinary setting is not redacted");
    // The one caller that files an issue still gets it.
    assert.equal(store.getSetting("github.token"), planted);
  });
});

// ---- the intake --------------------------------------------------------------------------------

const post = (cp, body, { token, tenant } = {}) => cp.request("POST", "/v1/feedback", {
  body,
  token,
  headers: tenant === undefined ? {} : { "x-titanbot-tenant": tenant },
});

test("the intake takes the relay token, and neither the admin token nor none", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: "r".repeat(40) } });
  try {
    assert.equal((await post(cp, REPORT, { tenant: "demo" })).status, 401, "no bearer opened it");
    // The admin token adds accounts and deletes services; the relay token reads every customer's
    // gateway token. Neither should ever be able to do the other's job.
    assert.equal((await post(cp, REPORT, { token: cp.config.adminToken, tenant: "demo" })).status, 401);
    assert.equal((await post(cp, REPORT, { token: "r".repeat(40), tenant: "demo" })).status, 201);
    // And the method refusal comes before the credential, so a wrong method learns nothing.
    assert.equal((await cp.request("GET", "/v1/feedback")).status, 405);
  } finally { await cp.dispose(); }
});

test("the workspace is the relay's forwarded one, and a slug in the body is ignored", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: "r".repeat(40) } });
  try {
    const answer = await post(cp, { ...REPORT, workspace: "victim", slug: "victim", tenant: "victim" },
      { token: "r".repeat(40), tenant: "demo" });
    assert.equal(answer.status, 201);
    const row = cp.store.getFeedback(answer.body.id);
    assert.equal(row.tenant, "demo", "a box filed as its neighbour");
    assert.equal(row.payload.evidence.workspace, "demo");
    assert.equal(JSON.stringify(row.payload).includes("victim"), false, "the body's own name survived into the record");
    // With no forwarded workspace there is nothing to file under and nothing is stored.
    const nameless = await post(cp, REPORT, { token: "r".repeat(40) });
    assert.equal(nameless.status, 400);
    assert.match(nameless.body.message, /which workspace/);
    assert.equal(cp.store.countFeedback(), 1);
  } finally { await cp.dispose(); }
});

test("a report carrying this service's own credential is refused and nothing is stored", async () => {
  const relayToken = "r".repeat(40);
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    for (const secret of [cp.config.sessionSecret, cp.config.adminToken, relayToken]) {
      const answer = await post(cp, { ...REPORT, description: `the box printed ${secret} at me` },
        { token: relayToken, tenant: "demo" });
      assert.equal(answer.status, 400, "a credential got through");
      assert.match(answer.body.message, /carried a credential/);
    }
    assert.equal(cp.store.countFeedback(), 0);
  } finally { await cp.dispose(); }
});

test("a workspace name that is not one is refused, and a bad payload is refused in words", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: "r".repeat(40) } });
  try {
    assert.equal((await post(cp, REPORT, { token: "r".repeat(40), tenant: "../../etc" })).status, 400);
    const bad = await post(cp, { ...REPORT, tier: "urgent" }, { token: "r".repeat(40), tenant: "demo" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /tier has to be one of/);
  } finally { await cp.dispose(); }
});

// ---- the panel ---------------------------------------------------------------------------------

function makeApi({ store, root, fetchImpl, relayToken = "r".repeat(32) }) {
  return createAdminApi({
    config: { dataDir: root, tenantRoot: root, relayUrl: "http://relay.invalid", relayToken, adminToken: "a".repeat(32) },
    store,
    client: { base: "", call: async () => ({}) },
    json: () => {}, noContent: () => {},
    publicAccount: (account) => account,
    publicTenant: (tenant) => tenant,
    tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
    tenantPower: async () => {}, tenantProvision: async () => {},
    currentSession: () => ({ ok: false }),
    log: () => {},
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

test("the panel counts every report and filters none of the counts away", async () => {
  await withStore((store, root) => {
    store.recordFeedback({ tenant: "demo", tier: "critical", title: "one", body: "b", payload: {} });
    store.recordFeedback({ tenant: "demo", tier: "quality", title: "two", body: "b", payload: {} });
    const api = makeApi({ store, root });
    const answer = api.feedback({ tier: "quality" });
    assert.equal(answer.rows.length, 1, "the list is filtered");
    // The number an operator needs on a bad morning is "how many critical are open", and a filter
    // is exactly what would hide it.
    assert.equal(answer.counts.criticalNew, 1, "the counts are not");
    assert.equal(answer.total, 2);
    assert.equal(answer.github.stored, false);
    assert.match(answer.github.why, /no repository token is stored/);
    assert.match(answer.gates, /shown to the workspace operator/);
    assert.equal(answer.retention, "these rows are never pruned");
    // Wave B's hook: no verification table in this tree, so the panel draws three filters.
    assert.equal(answer.verification.table, null);
    assert.deepEqual(answer.verification.rows, []);
  });
});

test("a stored GitHub token is reported as evidence and never as a value", async () => {
  await withStore((store, root) => {
    const planted = `ghp_${randomBytes(20).toString("hex")}`;
    store.setSetting("github.token", planted, "boss@example.com");
    store.setSetting("github.repo", "acme/widgets", "boss@example.com");
    const answer = makeApi({ store, root }).feedback({});
    assert.equal(answer.github.stored, true);
    assert.equal(answer.github.repo, "acme/widgets");
    assert.match(answer.github.evidence, /^\d+ characters, sha256 [0-9a-f]{8}$/);
    assert.equal(JSON.stringify(answer).includes(planted), false, "the panel answer carried the token");
  });
});

// ---- the issue door ----------------------------------------------------------------------------

test("a token GitHub refuses is not stored, and the reason is a sentence", async () => {
  const answers = { "/repos/acme/widgets": { status: 404, body: { message: "Not Found" } } };
  const proof = await proveRepoToken({
    token: "ghp_whatever",
    repo: "acme/widgets",
    fetchImpl: async (url) => {
      const key = new URL(url).pathname;
      const answer = answers[key] ?? { status: 200, body: {} };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    },
  });
  assert.equal(proof.ok, false);
  assert.match(proof.why, /no such repository/);
});

test("a repository with its issues turned off is refused before anything is stored", async () => {
  const proof = await proveRepoToken({
    token: "ghp_whatever",
    repo: "acme/widgets",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ has_issues: false }) }),
  });
  assert.equal(proof.ok, false);
  assert.match(proof.why, /issues turned off/);
});

test("filing an issue never throws and never carries the token back", async () => {
  const token = `ghp_${randomBytes(20).toString("hex")}`;
  let sawAuthorization = "";
  const ok = await fileIssue({
    token, repo: "acme/widgets", title: "t", body: "b",
    fetchImpl: async (url, init) => {
      sawAuthorization = String(init.headers.authorization ?? "");
      return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/acme/widgets/issues/9", number: 9 }) };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, "https://github.com/acme/widgets/issues/9");
  assert.equal(sawAuthorization.includes(token), true, "the token goes in exactly one place");
  assert.equal(JSON.stringify(ok).includes(token), false, "and comes back in none");

  const down = await fileIssue({ token, repo: "acme/widgets", title: "t", body: "b", fetchImpl: async () => { throw new Error("no network"); } });
  assert.equal(down.ok, false);
  assert.match(down.why, /nothing was filed/);
  assert.equal(JSON.stringify(down).includes(token), false);
});
