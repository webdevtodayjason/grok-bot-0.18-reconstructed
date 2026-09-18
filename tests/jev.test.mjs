// JEV-2. The Jev judgements, behind SAND_JEV, off by default.
//
// Two things this file is really about. The first is that every failure there is falls back to the
// turn that would have happened anyway: a judge that times out, refuses, or answers in a shape this
// host cannot read must leave no trace on the turn at all. The second is that low confidence never
// produces a confident line, because the failure this feature exists to stop was a confident answer
// to a slightly different question.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".jev-test-"));
const dataRoot = mkdtempSync(path.join(tmpdir(), "jev-data-"));
after(() => { rmSync(stage, { recursive: true, force: true }); rmSync(dataRoot, { recursive: true, force: true }); });

// The ledger writes under the sand root, so the whole suite runs against a throwaway one.
process.env.SAND_DATA_ROOT = dataRoot;

const entry = path.join(stage, "entry.ts");
writeFileSync(entry, [
  "client", "questions", "ledger", "judgment-1", "judgment-3", "turn-state", "turn-note", "chip",
  "evidence", "outgoing", "mark-wrong",
].map((name) => `export * from ${JSON.stringify(path.join(repoRoot, `source/host/jev/${name}.js`))};`)
  .concat([`export { isJevEnabled } from ${JSON.stringify(path.join(repoRoot, "source/host/sand-box-setting.js"))};`, ""])
  .join("\n"), "utf8");
const built = await build({
  entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
  target: "es2022", external: ["jsonc-parser"], logLevel: "silent",
});
const bundlePath = path.join(stage, "jev.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text, "utf8");
const jev = createRequire(import.meta.url)(bundlePath);

const KEY = "test-key-not-a-real-one";
const quiet = { log: () => {} };
const withKey = (extra = {}) => ({ apiKey: KEY, ...quiet, ...extra });

/** A server that answers however the test says, and records what it was sent. */
async function startServer(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, body });
      handler(res, body);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  return { endpoint, seen, close: () => new Promise((done) => server.close(done)) };
}

const noulAnswer = (value) => ({ type: "noul", noul: value });
const choiceAnswer = (choice, confidence) => ({ type: "choice", choice, confidence });
const replyOf = (answers) => JSON.stringify({ answers, model: "jev-1.13.0", usage: { input_tokens: 11, output_tokens: 0 } });

// --------------------------------------------------------------------------- the client

test("a server that never answers costs the deadline and returns nothing", async () => {
  const server = await startServer(() => {});
  try {
    const startedAt = Date.now();
    const answer = await jev.askJev({ request: "x" }, jev.JUDGMENT_1_QUESTIONS,
      withKey({ endpoint: server.endpoint, timeoutMs: 120 }));
    assert.equal(answer, undefined, "a timeout is no answer, never a throw");
    assert.ok(Date.now() - startedAt < 2_000, "it gave up on its own deadline");
  } finally { await server.close(); }
});

test("a 429 is not retried and returns nothing", async () => {
  let calls = 0;
  const server = await startServer((res) => {
    calls += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "slow down" }));
  });
  try {
    assert.equal(await jev.askJev({}, jev.JUDGMENT_3_QUESTIONS, withKey({ endpoint: server.endpoint })), undefined);
    assert.equal(calls, 1, "one attempt: a retry inside a turn spends the deadline twice");
  } finally { await server.close(); }
});

test("an answer this host cannot read is the same as no answer", async () => {
  for (const body of ["not json at all", JSON.stringify({ answers: { scope: { type: "mystery" } } }),
    JSON.stringify({ answers: { scope: { type: "noul", noul: "high" } } })]) {
    const server = await startServer((res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    try {
      assert.equal(await jev.askJev({}, jev.JUDGMENT_1_QUESTIONS, withKey({ endpoint: server.endpoint })), undefined,
        `malformed body handled: ${body.slice(0, 40)}`);
    } finally { await server.close(); }
  }
});

test("the key travels as a bearer and the state never reaches the log", async () => {
  const lines = [];
  const server = await startServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(replyOf({ is_universal_negative: noulAnswer(0.1) }));
  });
  try {
    const answer = await jev.askJev({ claim: "a secret claim about a customer" }, jev.JUDGMENT_3_QUESTIONS,
      { apiKey: KEY, endpoint: server.endpoint, log: (line) => lines.push(line) });
    assert.equal(answer.model, "jev-1.13.0");
    assert.equal(answer.inputTokens, 11);
    assert.equal(server.seen[0].authorization, `Bearer ${KEY}`);
    const logged = lines.join(" ");
    assert.ok(logged.includes("jev-1.13.0"), "the log names the model");
    assert.ok(!logged.includes("secret claim"), "the log never carries the state");
    assert.ok(!logged.includes(KEY), "the log never carries the key");
  } finally { await server.close(); }
});

test("no key on the box means no request at all", async () => {
  let called = false;
  const answer = await jev.askJev({}, jev.JUDGMENT_1_QUESTIONS,
    { ...quiet, apiKey: undefined, fetchImpl: async () => { called = true; return new Response("{}"); } });
  assert.equal(answer, undefined);
  assert.equal(called, false);
});

// --------------------------------------------------------------------------- judgment 1

test("the question test reads a question without asking the judge", () => {
  for (const asked of ["Who carries this locally?", "where can I get one", "Is it in stock",
    "does anyone sell these", "How much are they"]) {
    assert.equal(jev.readsAsQuestion(asked), true, `a question: ${asked}`);
  }
  for (const told of ["Book me a table at seven.", "Remind me tomorrow", ""]) {
    assert.equal(jev.readsAsQuestion(told), false, `not a question: ${told}`);
  }
});

test("scope is stated only at 0.9 and above, and says so plainly below it", () => {
  const confident = jev.renderConstraintsNote({ answers: { scope: choiceAnswer("local_in_store", 0.95) } });
  assert.ok(confident[0].includes("physical stores near them"), `stated (got ${confident[0]})`);
  for (const confidence of [0.89, 0.7, 0.4]) {
    const unsure = jev.renderConstraintsNote({ answers: { scope: choiceAnswer("local_in_store", confidence) } });
    assert.equal(unsure[0], "scope: not determined, do not assume", `at ${confidence} it does not guess`);
    assert.ok(!unsure.join(" ").includes("physical stores near them"), "and it never states the guess anyway");
  }
});

test("a noul is a hard constraint at 0.9, hedged at 0.7, and silent below", () => {
  const lineFor = (noul) => jev.renderConstraintsNote({
    answers: { scope: choiceAnswer("unclear", 0.2), names_stores: noulAnswer(noul) },
  }).filter((line) => line.includes("names specific stores"));
  assert.deepEqual(lineFor(0.95), ["the request names specific stores: respect them and report on every one"]);
  assert.deepEqual(lineFor(0.8), ["likely: the request names specific stores: respect them and report on every one"]);
  assert.deepEqual(lineFor(0.62), [], "below 0.7 it is not mentioned at all");
  assert.deepEqual(lineFor(0.02), [], "a confident false is the absence of a constraint, not a constraint");
});

test("the note is appended as a host note and never rewrites the person's words", () => {
  const text = jev.constraintsNoteText(["scope: not determined, do not assume"]);
  assert.ok(text.startsWith("<system_reminder>"));
  assert.ok(text.includes("not a rewrite of their words"));
  assert.ok(text.trimEnd().endsWith("</system_reminder>"));
});

// --------------------------------------------------------------------------- judgment 3

test("claims are the negatives plus the answer line, and nothing else", () => {
  const message = [
    "ANSWER: Confirmed at none of the 3 sources checked.",
    "Home Depot has a 10-pack in Cedar Park.",
    "Nobody in Leander stocks a 25-pack.",
    "Lowe's does not carry the 8 inch length.",
  ].join("\n");
  const claims = jev.extractClaims(message);
  assert.ok(claims.some((claim) => claim.startsWith("ANSWER:")), "the answer line always counts");
  assert.ok(claims.some((claim) => claim.includes("Nobody in Leander")));
  assert.ok(claims.some((claim) => claim.includes("does not carry")));
  assert.ok(!claims.some((claim) => claim.includes("has a 10-pack")), "a positive sentence is not a claim to check");
});

test("a universal negative is sent back whatever the evidence is said to say", () => {
  const verdict = jev.judgeClaim({ answers: {
    is_universal_negative: noulAnswer(0.72),
    support: choiceAnswer("supports", 0.99),
  } });
  assert.equal(verdict.action, "scope");
  assert.equal(verdict.refusal, jev.SCOPE_REFUSAL);
  assert.ok(verdict.refusal.includes("Confirmed at none of the N sources checked"));
});

test("supports at 0.95 goes out, and anything less is softened", () => {
  assert.equal(jev.judgeClaim({ answers: { is_universal_negative: noulAnswer(0.1), support: choiceAnswer("supports", 0.95) } }).action, "pass");
  assert.equal(jev.judgeClaim({ answers: { is_universal_negative: noulAnswer(0.1), support: choiceAnswer("supports", 0.89) } }).action, "soften");
  assert.equal(jev.judgeClaim({ answers: { is_universal_negative: noulAnswer(0.1), support: choiceAnswer("no_evidence", 0.99) } }).action, "soften");
  assert.equal(jev.judgeClaim({ answers: { is_universal_negative: noulAnswer(0.1), support: choiceAnswer("contradicts", 0.99) } }).refusal, jev.SOFTEN_REFUSAL);
});

test("a turn is sent back at most twice, then the message goes out and the ledger says why", async () => {
  const agentId = "jev-cap-agent";
  mkdirSync(path.join(dataRoot, "agents", agentId), { recursive: true });
  const server = await startServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(replyOf({ is_universal_negative: noulAnswer(0.95), support: choiceAnswer("no_evidence", 0.9) }));
  });
  try {
    const counter = jev.createJevRefusalCounter();
    const check = () => jev.runClaimCheck({
      agentId, turnId: "turn-1", message: "Nobody sells it.", evidence: [],
      sourcesChecked: [], sourcesNamedInRequest: [], counter,
    }, withKey({ endpoint: server.endpoint }));
    assert.equal((await check()).refusal, jev.SCOPE_REFUSAL, "first send back");
    assert.equal((await check()).refusal, jev.SCOPE_REFUSAL, "second send back");
    const third = await check();
    assert.equal(third.refusal, undefined, "the third goes out as written");
    assert.equal(counter.refusals, 2);
    const ledger = jev.readJevLedger === undefined ? [] : await jev.readJevLedger(agentId);
    const allowed = ledger.filter((row) => typeof row.action === "string" && row.action.includes("spent its 2 refusals"));
    assert.equal(allowed.length, 1, "the ledger records that it was allowed because the turn had spent its refusals");
  } finally { await server.close(); }
});

test("a judge that says nothing lets the message through unchanged", async () => {
  const server = await startServer((res) => { res.writeHead(500); res.end("no"); });
  try {
    const outcome = await jev.runClaimCheck({
      agentId: "jev-quiet-agent", turnId: "t", message: "Nobody sells it.", evidence: [],
      sourcesChecked: [], sourcesNamedInRequest: [], counter: jev.createJevRefusalCounter(),
    }, withKey({ endpoint: server.endpoint }));
    assert.equal(outcome.refusal, undefined);
    assert.equal(outcome.decisions.length, 0);
  } finally { await server.close(); }
});

// --------------------------------------------------------------------------- the ledger

test("a ledger line carries the decision and never the state", async () => {
  const agentId = "jev-ledger-agent";
  mkdirSync(path.join(dataRoot, "agents", agentId), { recursive: true });
  const row = await jev.recordJevDecision(agentId, {
    turnId: "turn-9", judgment: 1, question: "scope", answer: "local_in_store",
    confidence: 0.95, action: "stated", model: "jev-1.13.0", latencyMs: 210,
  });
  assert.equal(row.band, "90plus");
  const written = readFileSync(path.join(dataRoot, "agents", agentId, "jev.jsonl"), "utf8").trim().split("\n");
  const parsed = JSON.parse(written[written.length - 1]);
  assert.deepEqual(Object.keys(parsed).sort(),
    ["action", "answer", "band", "confidence", "id", "judgment", "latencyMs", "model", "question", "ts", "turnId"]);
  assert.equal(parsed.turnId, "turn-9");
  assert.ok(!("state" in parsed) && !("request" in parsed) && !("evidence" in parsed) && !("claim" in parsed));

  const marker = await jev.markJevDecisionWrong(agentId, row.id, "jason@titaniumcomputing.com");
  assert.deepEqual(Object.keys(marker).sort(), ["by", "id", "ts", "wrong"]);
  const after = readFileSync(path.join(dataRoot, "agents", agentId, "jev.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(after[after.length - 1]);
  assert.equal(last.wrong, true);
  assert.equal(last.id, row.id, "the marker points at the decision rather than replacing it");
  assert.equal(after.length, written.length + 1, "the original decision is still there");
});

test("the bands are the three the feature is written in", () => {
  assert.equal(jev.jevBand(0.9), "90plus");
  assert.equal(jev.jevBand(0.7), "70to90");
  assert.equal(jev.jevBand(0.69), "below70");
});

test("jevMarkWrong refuses arguments it cannot attribute", () => {
  assert.equal(jev.checkJevMarkWrong({ agentId: "a", decisionId: "d", by: "x@y" }).ok, true);
  assert.equal(jev.checkJevMarkWrong({ agentId: "a", decisionId: "d" }).ok, false);
  assert.equal(jev.checkJevMarkWrong({ decisionId: "d", by: "x@y" }).ok, false);
  assert.equal(jev.checkJevMarkWrong("nope").ok, false);
});

// --------------------------------------------------------------------------- the flag

test("with SAND_JEV off nothing runs and no request is made", async () => {
  delete process.env.SAND_JEV;
  assert.equal(jev.isJevEnabled(), false, "off unless a box says otherwise");
  let called = false;
  const note = await jev.buildJevTurnNote("jev-off-agent", "Who carries this locally?", "m-1",
    { ...quiet, apiKey: KEY, fetchImpl: async () => { called = true; return new Response("{}"); } });
  assert.equal(note, undefined);
  assert.equal(called, false, "the flag is read before anything is sent anywhere");
  assert.equal(jev.currentJevTurn("jev-off-agent"), undefined, "and no turn state is left behind");
});

test("with SAND_JEV on a question is judged and a statement is not", async () => {
  process.env.SAND_JEV = "1";
  try {
    const agentId = "jev-on-agent";
    mkdirSync(path.join(dataRoot, "agents", agentId), { recursive: true });
    const server = await startServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(replyOf({
        scope: choiceAnswer("local_in_store", 0.96),
        names_stores: noulAnswer(0.97), names_location: noulAnswer(0.98),
        names_quantity: noulAnswer(0.8), substitutes_ok: noulAnswer(0.05),
      }));
    });
    try {
      const note = await jev.buildJevTurnNote(agentId, "Who carries these bolts in Leander?", "m-2",
        withKey({ endpoint: server.endpoint }));
      assert.ok(note.includes("physical stores near them"), "the scope it was sure of is stated");
      assert.ok(note.includes("likely: the request states a quantity"), "0.8 is hedged");
      assert.ok(!note.includes("substitute"), "a confident false says nothing");
      assert.equal(jev.currentJevTurn(agentId).turnId, "m-2", "both judgements stamp the same turn");

      // A statement costs nothing: the question test runs before the request does.
      const before = server.seen.length;
      const none = await jev.buildJevTurnNote(agentId, "Order me more of those.", "m-3",
        withKey({ endpoint: server.endpoint }));
      assert.equal(none, undefined);
      assert.equal(server.seen.length, before, "no request for something that is not a question");
    } finally { await server.close(); }
  } finally { delete process.env.SAND_JEV; }
});

// --------------------------------------------------------------------------- evidence and the chip

test("evidence is trimmed and keeps its domain", () => {
  const trimmed = jev.trimEvidence({ source: "lowes.com", text: `${"a".repeat(5_000)}` });
  assert.ok(trimmed.text.length <= jev.EVIDENCE_CHARS + 4);
  assert.equal(trimmed.source, "lowes.com");
  assert.equal(jev.firstDomain('{"url":"https://www.homedepot.com/p/123"}', "WebSearch"), "homedepot.com");
  assert.equal(jev.firstDomain("nothing here", "WebSearch"), "WebSearch");
});

test("a search result is kept for the turn and the result itself is untouched", async () => {
  const turn = jev.startJevTurn("jev-evidence-agent");
  const tool = jev.collectJevEvidence({
    name: "WebSearch",
    execute: async () => ({ results: [{ url: "https://acehardware.com/x", snippet: "in stock" }] }),
  }, turn);
  const result = await tool.execute();
  assert.deepEqual(result.results[0].snippet, "in stock", "the tool's own result is handed back unchanged");
  assert.equal(turn.evidence.length, 1);
  assert.equal(turn.evidence[0].source, "acehardware.com");
  assert.ok(jev.isJevWebToolName("web_search") && jev.isJevWebToolName("WebFetch"));
  assert.equal(jev.isJevWebToolName("Shell"), false);
});

test("the chip says it in plain words and names the decision to disagree with", () => {
  const sentBack = jev.describeJevDecisions([
    { id: "d1", judgment: 1, question: "scope", answer: "local_in_store", confidence: 0.95, action: "stated" },
    { id: "d2", judgment: 3, question: "is_universal_negative", answer: "true", confidence: 0.9, action: "sent back to scope" },
  ]);
  assert.deepEqual(sentBack, { text: "Claim sent back to be scoped", decisionId: "d2" });
  const judged = jev.describeJevDecisions([
    { id: "d1", judgment: 1, question: "scope", answer: "local_in_store", confidence: 0.95, action: "stated" },
  ]);
  assert.deepEqual(judged, { text: "Judged: local stock question, 95%", decisionId: "d1" });
  assert.equal(jev.describeJevDecisions([]), undefined);
  // host-notes-read-as-errors: no prefix, no condition name, nothing that reads as a fault.
  for (const chip of [sentBack.text, judged.text]) {
    assert.ok(!/^[A-Z_]+:/.test(chip.replace("Judged:", "")), `no prefixed condition name in ${chip}`);
    assert.ok(!/error|fail|invalid|refused/i.test(chip), `nothing that reads as a fault in ${chip}`);
  }
});

test("the question wording is the harness's wording, not a paraphrase", () => {
  const harness = readFileSync(path.join(repoRoot, "scripts", "jev-eval.mjs"), "utf8");
  for (const [id, question] of [...Object.entries(jev.JUDGMENT_1_QUESTIONS), ...Object.entries(jev.JUDGMENT_3_QUESTIONS)]) {
    assert.ok(harness.includes(question.instructions),
      `${id}: the instructions must be the harness's, word for word`);
    for (const [name, criterion] of Object.entries(question.criteria)) {
      assert.ok(harness.includes(criterion), `${id}.${name}: the criterion must be the harness's, word for word`);
    }
  }
});
