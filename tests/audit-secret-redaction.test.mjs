// PROXY-9. The action ledger and the outline's shell rows must not carry a credential.
//
// MEASURED ON THE R750 2026-09-08: agent f97bfb2e's audit.jsonl in Jason's box (352 lines) carried
// the value of connector-env-secrets.json/shell/TINYFISH_API_KEY twice, in full, len 44, sha256
// prefix 9165ce2daa86. The write path had no redaction of any kind, so the second occurrence was
// not bad luck.
//
// The fake key below is 44 characters like the real one and is not a credential to anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".audit-redaction-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, `${name}.cjs`);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const redaction = await load("source/host/secret-redaction.ts", "secret-redaction");
const audit = await load("source/host/extensions/action-audit/action-audit-service.ts", "action-audit-service");

const FAKE_KEY = "tf-live-0123456789abcdef0123456789abcdefABCD";
const prefix = createHash("sha256").update(FAKE_KEY, "utf8").digest("hex").slice(0, 12);

const sandRoot = mkdtempSync(path.join(os.tmpdir(), "sand-redaction-"));
after(() => rmSync(sandRoot, { recursive: true, force: true }));
mkdirSync(sandRoot, { recursive: true });
writeFileSync(path.join(sandRoot, "connector-env-secrets.json"),
  JSON.stringify({ shell: { TINYFISH_API_KEY: FAKE_KEY } }), "utf8");
writeFileSync(path.join(sandRoot, "box-secrets.json"), JSON.stringify({
  version: 1,
  secrets: {
    SAND_OPENAI_COMPATIBLE_MODEL: "grok-4",
    SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "128000",
    SAND_SOME_KEY: "sk-a-long-enough-secret-value-here",
  },
}), "utf8");

test("a value from either secret store is replaced by its own hash prefix", () => {
  const redact = redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 });
  const line = redact(`curl -H "authorization: Bearer ${FAKE_KEY}" https://example.invalid`);
  assert.equal(line.includes(FAKE_KEY), false, "the key survived the redaction");
  assert.equal(line.includes(`<redacted:${prefix}>`), true, `no redaction token in: ${line}`);
  // Both stores, not just the connector one: box-secrets.json is where the endpoint pin lives and
  // an operator has put a provider key there before.
  assert.equal(redact("echo sk-a-long-enough-secret-value-here").includes("sk-a-long"), false,
    "a box-secrets.json value went into the ledger unredacted");
});

test("a setting is not a secret, and short values are left where they are", () => {
  const redact = redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 });
  const line = redact("run --model grok-4 --context 128000 --retries 3");
  assert.equal(line, "run --model grok-4 --context 128000 --retries 3",
    "a model name or a context window was redacted, which would mangle every row in the ledger");
  assert.equal(redaction.isRedactableSecretValue("grok-4"), false);
  assert.equal(redaction.isRedactableSecretValue("a value with spaces in it"), false);
  assert.equal(redaction.isRedactableSecretValue(FAKE_KEY), true);
});

test("the longest match wins, so a key containing another leaves no tail behind", () => {
  const outer = "AAAAAAAAAAAAAAAAAAAA";
  const inner = "AAAAAAAAAAAA";
  const out = redaction.redactSecretValues(`x ${outer} y`, [inner, outer]);
  assert.equal(out, `x ${redaction.secretRedactionToken(outer)} y`);
});

test("a shell ledger line is written with the credential already gone", () => {
  audit.setActionAuditRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const line = audit.localAuditJsonlLine({
    occurredAtMs: 1_700_000_000_000,
    agentId: "f97bfb2e-fcbb-4955-b4a1-5ea0408497dd",
    turnId: "turn-1",
    action: { kind: "shellCommand", command: `echo ${FAKE_KEY}`, shellKind: "bash", target: "box" },
  }, "event-1");
  const row = JSON.parse(line);
  assert.equal(row.type, "shell_command");
  assert.equal(row.command.includes(FAKE_KEY), false, "the ledger row still carries the key");
  assert.equal(row.command, `echo <redacted:${prefix}>`);
  assert.equal(line.includes(FAKE_KEY), false, "the key is elsewhere in the same line");
});

test("a browser row's URL is redacted too, because a token travels in a query string", () => {
  audit.setActionAuditRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const row = JSON.parse(audit.localAuditJsonlLine({
    occurredAtMs: 1_700_000_000_000,
    agentId: "f97bfb2e-fcbb-4955-b4a1-5ea0408497dd",
    action: { kind: "browserNavigation", url: `https://example.invalid/?key=${FAKE_KEY}`, pageTitle: "x" },
  }, "event-2"));
  assert.equal(row.url.includes(FAKE_KEY), false);
  assert.equal(row.url, `https://example.invalid/?key=<redacted:${prefix}>`);
});

test("no secret store at all writes the line unchanged rather than failing", () => {
  const redact = redaction.createBoxSecretRedactor({ sandRoot: path.join(sandRoot, "absent"), cacheMs: 0 });
  assert.equal(redact(`echo ${FAKE_KEY}`), `echo ${FAKE_KEY}`);
});

// The fourth writer into the same file, and the one the row's own fix left open. The action auditor
// redacts the shell COMMAND it appends to agents/<id>/audit.jsonl. The evidence registry appends a
// tool_result record to that SAME ledger carrying the head of the tool's OUTPUT, and that was going
// down unredacted -- so the command was clean and whatever the command printed was not. A turn that
// echoes a stored secret wrote it to disk in full.
test("and the evidence ledger's tool_result head, which is the shell command's own output", async () => {
  const evidence = await load("source/host/extensions/evidence/evidence-registry.ts", "evidence-registry");
  evidence.setEvidenceLedgerRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const agentId = "f97bfb2e-fcbb-4955-b4a1-5ea0408497dd";
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "sand-evidence-"));
  after(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const ledger = path.join(ledgerDir, "audit.jsonl");
  const registry = evidence.evidenceRegistry ?? evidence.default;
  registry.configure({ ledgerPath: () => ledger });

  const attestation = registry.attest(agentId, {
    toolCallId: "call-1", tool: "shell", ok: true, exitCode: 0,
    result: `the key is ${FAKE_KEY}\n`,
  });

  // Written down: redacted.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const written = readFileSync(ledger, "utf8");
  assert.equal(written.includes(FAKE_KEY), false, "the evidence ledger still carries the key");
  assert.match(written, new RegExp(`<redacted:${prefix}>`), "and it should say what it took out");

  // Held in memory: NOT redacted, on purpose. evidence-verdict decides a claim by looking for its
  // tokens in attestation.head, and the job bus reads the same heads. Redacting those would change
  // what the host concludes about a turn rather than what it writes down.
  assert.equal(attestation.head.includes(FAKE_KEY), true, "the verdict path must still see the real result");
  // And the attestation is of the REAL result, not the redacted copy.
  assert.equal(attestation.sha256, createHash("sha256").update(`the key is ${FAKE_KEY}\n`, "utf8").digest("hex"));
});


// ---- The outbox, which is the second copy nobody was looking at ---------------------------------
//
// `auditor.record` redacted the line it appended to audit.jsonl and then pushed the RAW action into
// `pending`. sand_action_audit_logs is pinned false, so runFlush takes the "not forwarding" branch
// every five seconds and persists that array to agents/audit-outbox.json forever -- a permanent
// second copy of up to 2,000 raw shell commands, on the same persistent mount the agent can read.
// Measured on the R750 2026-09-08: 394, 264 and 28 shellCommand rows in those files on the three
// boxes. Both directions are held below, because turning the gate on sends the same strings off-box.
test("the persisted outbox carries the redacted command, not the raw one", async () => {
  audit.setActionAuditRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "sand-outbox-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const outboxPath = path.join(dir, "audit-outbox.json");
  const created = audit.createSandActionAuditor({
    isBackendForwardingEnabled: () => false,
    sendBatch: async () => { throw new Error("must not forward when the gate is off"); },
    flushPolicy: { start: () => ({ dispose: () => {} }) },
    outboxPath,
    auditPath: () => path.join(dir, "audit.jsonl"),
  });
  created.auditor.record({
    occurredAtMs: 1_700_000_000_000,
    agentId: "f97bfb2e-fcbb-4955-b4a1-5ea0408497dd",
    action: { kind: "shellCommand", command: `echo ${FAKE_KEY}`, shellKind: "bash", target: "box" },
  });
  await created.dispose();
  const written = readFileSync(outboxPath, "utf8");
  assert.equal(written.includes(FAKE_KEY), false, "the outbox on the persistent mount still holds the key");
  assert.equal(written.includes(`<redacted:${prefix}>`), true, `no redaction token in the outbox: ${written}`);
});

test("and the batch handed to the backend carries the redacted command too", async () => {
  audit.setActionAuditRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "sand-outbox-on-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const created = audit.createSandActionAuditor({
    isBackendForwardingEnabled: () => true,
    sendBatch: async (events) => { sent.push(...events); },
    flushPolicy: { start: () => ({ dispose: () => {} }) },
    outboxPath: path.join(dir, "audit-outbox.json"),
    auditPath: () => path.join(dir, "audit.jsonl"),
  });
  created.auditor.record({
    occurredAtMs: 1_700_000_000_000,
    agentId: "f97bfb2e-fcbb-4955-b4a1-5ea0408497dd",
    action: { kind: "browserNavigation", url: `https://example.invalid/?key=${FAKE_KEY}`, pageTitle: "x" },
  });
  await created.dispose();
  assert.equal(sent.length, 1, "nothing was forwarded, so this proved nothing");
  assert.equal(JSON.stringify(sent[0]).includes(FAKE_KEY), false, "the forwarded batch still carries the key");
  assert.equal(sent[0].action.url, `https://example.invalid/?key=<redacted:${prefix}>`);
});

// ---- The outline, which is the screen PROXY-9 was written about ---------------------------------
//
// The first pass redacted only the standalone `shellConversationTurn`. The path an agent's own shell
// command takes is agentConversationTurn -> toolCall -> shellToolCall -> stepToOutlineItem ->
// shellOutline, and it had no redactor anywhere: the raw command went into `summary` and the raw
// stdout into `output`. Measured on grok-bot-local-vm: one conversation's outline of 1,578 items
// held 54 shellToolCall rows and all 54 carried a populated `output`. So the leg below is built
// from an agent turn, which is the shape the console actually draws.
test("an AGENT turn's shell row is redacted in both its command and its output", async () => {
  const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
  outline.setOutlineRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const items = outline.deriveOutlineFromConversationState({
    turns: [{
      turn: {
        case: "agentConversationTurn",
        value: {
          userMessage: { text: "print it", messageId: "m1" },
          steps: [{
            message: {
              case: "toolCall",
              value: {
                tool: {
                  case: "shellToolCall",
                  value: {
                    args: { command: `printf %s "$TINYFISH_API_KEY" # ${FAKE_KEY}` },
                    result: { result: { case: "success", value: { stdout: FAKE_KEY, exitCode: 0 } } },
                  },
                },
              },
            },
          }],
        },
      },
    }],
  });
  const row = items.find((item) => item.kind === "tool-call");
  assert.ok(row != null, "no tool-call row was drawn at all");
  assert.equal(JSON.stringify(row).includes(FAKE_KEY), false, `the key is on the drawn row: ${JSON.stringify(row)}`);
  assert.equal(row.summary.includes(`<redacted:${prefix}>`), true, `summary not redacted: ${row.summary}`);
  assert.equal(row.output, `<redacted:${prefix}>`);
});

test("and a non-shell tool's serialized arguments, which land on the same page", async () => {
  const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
  outline.setOutlineRedactor(redaction.createBoxSecretRedactor({ sandRoot, cacheMs: 0 }));
  const args = { toJson: () => ({ server: "tinyfish", headers: { "X-API-Key": FAKE_KEY } }) };
  const summary = outline.getOutlineToolCallSummary({ tool: { case: "mcpToolCall", value: { args } } });
  assert.equal(summary.includes(FAKE_KEY), false, `an MCP call's arguments carried the key: ${summary}`);
  assert.equal(summary.includes(`<redacted:${prefix}>`), true, summary);
});
