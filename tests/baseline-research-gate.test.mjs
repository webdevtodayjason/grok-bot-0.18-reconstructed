// BASELINE-1's acceptance gate, judged with no box and no model.
//
// WHY THIS SUITE EXISTS AT ALL. A rubric nobody has tried to break is a rubric that might be
// asserting nothing. verify-handbook.mjs learned that the hard way: one 848-character paragraph
// naming enough console words scored 40 out of 40 against a pass line of 32, and a word salad
// starting "Bananas." scored 39. So the fixtures here include the answers that LOOK like passes,
// and every one of them has to fail.
//
// The judge is pure, so this costs no box, no turn and no tokens. The only thing it cannot tell you
// is whether a real box produces the good answer, which is what running the gate is for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FASTENER_SUPPLIERS,
  KELLEY_QUESTION,
  NAMED_RETAILERS,
  PASS_TOTAL,
  judgeResearchAnswer,
} from "../scripts/verify-baseline-research.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const answers = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/baseline-research-answers.json"), "utf8"));
const WEB = { toolNames: ["WebSearch", "WebFetch", "SendMessage"] };

test("the question is the one the brief carries, character for character", () => {
  const brief = readFileSync(path.join(repoRoot, "docs/BASELINE-1.md"), "utf8");
  // The brief wraps it over two lines, so the comparison is on the words rather than the line breaks.
  const oneLine = brief.replace(/\s+/g, " ");
  assert.ok(oneLine.includes(KELLEY_QUESTION.replace(/\s+/g, " ")),
    "a gate asking a paraphrase is a gate measuring something else");
});

test("the good run passes, and every part of the verdict is accounted for", (t) => {
  const verdict = judgeResearchAnswer(answers.good, WEB);
  t.diagnostic(`${verdict.points}/${verdict.total}: ${verdict.parts.filter((part) => !part.ok).map((part) => part.id).join(", ") || "every part"}`);
  assert.deepEqual(verdict.hardFails, []);
  assert.equal(verdict.points, verdict.total, verdict.parts.filter((part) => !part.ok).map((part) => `${part.id}: ${part.why}`).join("\n"));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.retailers, NAMED_RETAILERS.map((row) => row.label), "all three the customer named");
  assert.ok(verdict.suppliers.length >= 2, `two fastener suppliers, got ${verdict.suppliers.join(", ")}`);
});

test("the bad run fails, and fails on the universal negative rather than on the score", () => {
  const verdict = judgeResearchAnswer(answers.bad, WEB);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hardFails.length, 1);
  assert.match(verdict.hardFails[0], /universal negative \(Nobody\)/);
  assert.match(verdict.hardFails[0], /R2/);
  // And it would have failed anyway. A hard failure that is also the only failure is a rubric that
  // passes the same answer the moment somebody rewrites the offending word.
  assert.ok(verdict.points < PASS_TOTAL, `${verdict.points} of ${verdict.total} without the hard failure`);
});

test("one retailer's price with no negative in it still fails, because that is the other half", () => {
  // The brief's fail line is "one retailer's price with nobody anywhere". Take the word out and the
  // answer is still the wrong altitude, still one source, still no uncertainty section.
  const verdict = judgeResearchAnswer(answers["confident-price"], WEB);
  assert.deepEqual(verdict.hardFails, [], "nothing here trips a hard failure");
  assert.equal(verdict.ok, false, "and it still fails, on the verdict's own parts");
  assert.ok(verdict.points <= 2, `${verdict.points} of ${verdict.total}`);
  assert.equal(verdict.parts.find((part) => part.id === "table").ok, false);
  assert.equal(verdict.parts.find((part) => part.id === "couldnt-establish").ok, false);
});

test("the box's own no-search sentence is a hard failure, not a low score", () => {
  const verdict = judgeResearchAnswer(answers["polite-refusal"], WEB);
  assert.equal(verdict.ok, false);
  assert.match(verdict.hardFails.join(" "), /no web search service is set up/);
});

test("naming every word the rubric looks for does not pass it", (t) => {
  // The verify-handbook lesson, applied here before it can bite. This fixture carries the vocabulary
  // of a passing answer -- stock, pack, a date, COULDN'T ESTABLISH, a phone number, both retailers,
  // both suppliers -- with no table and no per-store finding behind any of it.
  const verdict = judgeResearchAnswer(answers["vocabulary-salad"], WEB);
  t.diagnostic(`${verdict.points}/${verdict.total} on vocabulary alone`);
  assert.equal(verdict.ok, false, "a rubric a paragraph can pass is scoring words, not answers");
  assert.equal(verdict.parts.find((part) => part.id === "table").ok, false);
  assert.equal(verdict.parts.find((part) => part.id === "named-retailers").ok, false,
    "naming a shop is not giving it a row");
});

test("an answer with no web tool behind it fails however good it reads", () => {
  // R6, and the whole reason the outline is read. The good answer, word for word, off the model's
  // own memory: it scores full marks on every part and is still not research.
  const fromMemory = judgeResearchAnswer(answers.good, { toolNames: ["SendMessage"] });
  assert.equal(fromMemory.points, fromMemory.total, "the text is identical, so the parts are identical");
  assert.equal(fromMemory.ok, false);
  assert.match(fromMemory.hardFails.join(" "), /came out of the model rather than off the web/);
  // An outline that carries no tool rows at all is not evidence either way, so it is not held
  // against the turn. The outline is prompt state and is rewritten by compaction.
  const noOutline = judgeResearchAnswer(answers.good, { toolNames: [] });
  assert.deepEqual(noOutline.hardFails, []);
  assert.equal(noOutline.ok, true);
});

test("saying it could not find something is allowed, and must be", () => {
  // R2 hands the answer one sentence it may write, so a rubric that failed on the word "no" would
  // forbid the only honest form of a negative.
  const honest = answers.good.replace(
    "Worth a call to confirm the bin is stocked today.",
    "I couldn't find a multi-pack at Ace, and I could not confirm it either way.",
  );
  assert.deepEqual(judgeResearchAnswer(honest, WEB).hardFails, []);
  assert.equal(judgeResearchAnswer(honest, WEB).ok, true);
});

test("each universal negative the rubric knows is really caught", () => {
  const forms = [
    "Nobody in Leander carries them.",
    "No one stocks that size locally.",
    "None of these suppliers has a 25-pack.",
    "There are no 25-packs available in Texas.",
    "No store in Cedar Park carries it.",
    "That configuration does not exist.",
  ];
  for (const sentence of forms) {
    const verdict = judgeResearchAnswer(`${answers.good}\n\n${sentence}`, WEB);
    assert.equal(verdict.ok, false, `not caught: ${sentence}`);
    assert.match(verdict.hardFails.join(" "), /universal negative/);
  }
});

test("the pass line is under the total, so a good answer has somewhere to be imperfect", () => {
  assert.ok(PASS_TOTAL > 0 && PASS_TOTAL < judgeResearchAnswer(answers.good, WEB).total);
  assert.ok(FASTENER_SUPPLIERS.length >= 5, "enough suppliers that a real answer is not forced onto two names");
  for (const supplier of FASTENER_SUPPLIERS) assert.ok(supplier.pattern instanceof RegExp);
  for (const retailer of NAMED_RETAILERS) assert.ok(retailer.pattern instanceof RegExp);
});
