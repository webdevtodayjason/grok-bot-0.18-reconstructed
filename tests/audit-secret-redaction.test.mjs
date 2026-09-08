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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
