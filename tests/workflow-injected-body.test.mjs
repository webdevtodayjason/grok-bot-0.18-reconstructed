// What a turn that invokes a skill is actually handed.
//
// A workflow's recipe is inlined into the prompt that invokes it, capped so one skill cannot
// swamp a turn. The cap used to be 8k and to cut with a bare slice, which is how the managed
// learn-from-demonstration skill (just under 10k) reached the model missing its last two
// sections: the one that says what skill to write and the one that says to release the queue
// file it just claimed. Nothing said so -- the cut was silent and mid-sentence.
//
// So two things are pinned here: a real managed skill fits whole, and a body that genuinely does
// not fit stops on a line break and says what is missing and where the rest lives.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".workflow-injected-body-test-"));
const bundlePath = path.join(stage, "workflow-model.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
after(() => rmSync(stage, { recursive: true, force: true }));
const { injectedWorkflowBody, parseWorkflowFile, WORKFLOW_INJECTED_BODY_LIMIT } =
  createRequire(import.meta.url)(bundlePath);

const seedBody = (id) => parseWorkflowFile(
  readFileSync(path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills", id, "SKILL.md"), "utf8"),
).body;

test("every seeded managed skill reaches the model whole", () => {
  for (const id of ["learn-from-demonstration", "add-connector"]) {
    const injected = injectedWorkflowBody({ body: seedBody(id), filePath: `/sand/skills/${id}/SKILL.md` });
    assert.equal(injected.isTruncated, false, `${id} does not fit under the ${WORKFLOW_INJECTED_BODY_LIMIT}-char cap`);
    assert.equal(injected.inlinedChars, injected.bodyChars);
    assert.equal(injected.text, seedBody(id).trim());
  }
});

test("the learning recipe still carries the two sections a cut used to drop", () => {
  const { text } = injectedWorkflowBody({ body: seedBody("learn-from-demonstration"), filePath: "" });
  assert.match(text, /^## 6\. Clean up and report$/m, "the agent is told to release the queue file it claimed");
  assert.match(text, /^## Sensitive information$/m);
  assert.match(text, /body: the GENERIC, reusable user-goal recipe/, "the write-the-skill payload survives");
});

test("a body that does not fit is cut on a line break and says so", () => {
  const body = `${"a".repeat(40)}\n`.repeat(2_000);
  const injected = injectedWorkflowBody({ body, filePath: "/sand/skills/huge/SKILL.md" });
  assert.equal(injected.isTruncated, true);
  assert.equal(injected.bodyChars, body.trim().length);
  assert.ok(injected.inlinedChars < injected.bodyChars);
  assert.ok(injected.inlinedChars <= WORKFLOW_INJECTED_BODY_LIMIT);
  assert.equal(injected.text.split("\n\n")[0].split("\n").at(-1), "a".repeat(40), "the cut lands on a line break");
  assert.match(injected.text, /\[This recipe is cut here: \d+ of \d+ characters are shown\. Read the rest from \/sand\/skills\/huge\/SKILL\.md before you act on it\.\]$/);
});

test("with no file path to read, the cut says the rest has to be asked for", () => {
  const injected = injectedWorkflowBody({ body: "x".repeat(WORKFLOW_INJECTED_BODY_LIMIT + 1), filePath: "" });
  assert.equal(injected.isTruncated, true);
  assert.equal(injected.inlinedChars, WORKFLOW_INJECTED_BODY_LIMIT, "a body with no line break is cut at the cap");
  assert.match(injected.text, /Ask for the rest before you act on it\.\]$/);
});
