// Claim provenance over the recorded Nemotron rounds (docs/evidence/nemotron-fabrication-2026-09-02.json)
// plus the constructed no-tool case. The verdict module has zero runtime imports, so it loads alone.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const fixture = JSON.parse(await readFile(path.join(repoRoot, "docs/evidence/nemotron-fabrication-2026-09-02.json"), "utf8"));
const { decideVerdict, evidenceTokens, EVIDENCE_CHECKER } = await load("source/host/extensions/evidence/evidence-verdict.ts");

const promptOf = (c) => c.outline.find((i) => i.kind === "user")?.text ?? "";
const replyOf = (c) => c.outline.filter((i) => i.kind === "send-message").at(-1).message.content;
// The attestation head in production is the shell tool's JSON result; the outline output is its stdout.
const attestationsOf = (c) => c.outline.filter((i) => i.kind === "tool-call" && i.output).map((i) => ({ head: JSON.stringify({ success: { stdout: i.output } }), truncated: false }));

test("recorded round 1: the tool ran, the reply invented a name -> unsupported, naming it", () => {
  const c = fixture.cases.recorded_round_1_invented;
  const r = decideVerdict(replyOf(c), promptOf(c), attestationsOf(c));
  assert.equal(r.verdict, "unsupported");
  assert.deepEqual(r.missing, ["grokbot-verify-x1ipm3y.txt"]);
  assert.equal(c.expected_on_disk, "grokbot-verify-hvtewbsc.txt");
});

test("recorded round 2: the tool ran again, the reply repeated the invention -> unsupported", () => {
  const c = fixture.cases.recorded_round_2_repeated;
  const r = decideVerdict(replyOf(c), promptOf(c), attestationsOf(c));
  assert.equal(r.verdict, "unsupported");
  assert.deepEqual(r.missing, ["grokbot-verify-x1ipm3y.txt"]);
});

test("constructed: no tool ran, the reply parroted the invention -> unverified (never observed live; built from the same strings)", () => {
  const c = fixture.cases.recorded_round_2_repeated;
  const r = decideVerdict(replyOf(c), promptOf(c), []);
  assert.equal(r.verdict, "unverified");
  assert.ok(r.missing.includes("grokbot-verify-x1ipm3y.txt"));
});

test("control (grok-4.6): the reply names what the tool returned -> evidenced", () => {
  const c = fixture.cases.control_grok_4_6_evidenced;
  const r = decideVerdict(replyOf(c), promptOf(c), attestationsOf(c));
  assert.equal(r.verdict, "evidenced");
  assert.deepEqual(r.missing, []);
});

test("an ack with nothing to check is conversational; a truncated head makes a miss undecidable", () => {
  assert.equal(decideVerdict("Checking /workspace now.", "", []).verdict, "conversational");
  const r = decideVerdict("see grokbot-verify-zzz.txt", "", [{ head: "other.txt", truncated: true }]);
  assert.equal(r.verdict, "undecidable");
});

test("tokens the user said are not claims; the rule is versioned", () => {
  const r = decideVerdict("I will look at notes.md", "please read notes.md", []);
  assert.equal(r.verdict, "conversational");
  assert.deepEqual(evidenceTokens("grok-4.6 e.g. 2026 /workspace a1b2c3d4e5f6a7b8 12345 https://x.y/z p.txt"), ["a1b2c3d4e5f6a7b8", "12345", "https://x.y/z", "p.txt"]);
  assert.equal(EVIDENCE_CHECKER, "containment@1");
});
