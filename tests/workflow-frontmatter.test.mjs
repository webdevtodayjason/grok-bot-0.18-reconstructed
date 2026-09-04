// The YAML frontmatter every SKILL.md is read through.
//
// parseWorkflowFile is on the path for every workflow file the host reads, user-authored skills
// included, and it grew a block-scalar branch because the real managed skills fold their
// description over several lines (`description: >-`), which the parser used to read as the
// literal string ">-". That branch had no direct coverage: the only case that touched it asserted
// one seed's description. These pin the four shapes it has to get right and, just as important,
// the shapes it must leave to the plain-scalar path so a round-tripped file still reads back.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(repoRoot, "source/shared/workflow-model.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".workflow-frontmatter-test-"));
const bundlePath = path.join(stage, "workflow-model.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
after(() => rmSync(stage, { recursive: true, force: true }));
const { parseWorkflowFile, serializeWorkflowFile } = createRequire(import.meta.url)(bundlePath);

const frontmatter = (yaml) => parseWorkflowFile(`---\n${yaml}\n---\nbody text\n`).data;

test("a literal block keeps its line breaks and one trailing newline", () => {
  const data = frontmatter(["name: Skill", "notes: |", "  first", "  second"].join("\n"));
  assert.equal(data.notes, "first\nsecond\n");
  assert.equal(data.name, "Skill", "the keys around a block are still read");
});

test("chomping decides the trailing newlines", () => {
  const lines = (chomp) => ["notes: |" + chomp, "  first", "", "", "next: after"].join("\n");
  assert.equal(frontmatter(lines("-")).notes, "first", "a minus clips every trailing newline");
  assert.equal(frontmatter(lines("")).notes, "first\n", "the default keeps exactly one");
  assert.equal(frontmatter(lines("+")).notes, "first\n\n", "a plus keeps the blank lines as written");
  assert.equal(frontmatter(lines("-")).next, "after", "the block ends at the first line back out to the key's indent");
});

test("a folded block joins its lines and keeps its paragraphs", () => {
  const data = frontmatter(["description: >-", "  Turn a demonstration", "  into a skill.", "", "  Use it when a recording finishes."].join("\n"));
  assert.equal(data.description, "Turn a demonstration into a skill.\n\nUse it when a recording finishes.");
});

test("a block scalar reads the same under a nested key", () => {
  const data = frontmatter(["metadata:", "  source: |-", "    line one", "    line two", "  other: plain"].join("\n"));
  assert.deepEqual(data.metadata, { source: "line one\nline two", other: "plain" });
});

test("only a bare marker starts a block; everything else stays a plain scalar", () => {
  assert.equal(frontmatter("description: a > b | c").description, "a > b | c");
  assert.equal(frontmatter('description: ">-"').description, ">-", "a quoted marker is text");
  assert.equal(frontmatter(["description: >- inline", "name: Skill"].join("\n")).description, ">- inline",
    "a marker with text after it is not a block header, and must not swallow the next key");
});

test("what serializeWorkflowFile writes is what parseWorkflowFile reads back", () => {
  const spec = {
    name: "Learning skill",
    description: "Turn a demonstration into a skill. Use when a recording finishes.",
    body: "# Heading\n\nBody with a: colon and a | pipe.",
    trigger: null,
  };
  const parsed = parseWorkflowFile(serializeWorkflowFile(spec));
  assert.equal(parsed.name, spec.name);
  assert.equal(parsed.description, spec.description);
  assert.equal(parsed.body, spec.body, "the serializer emits quoted scalars, so the round trip never takes the block path");
});
