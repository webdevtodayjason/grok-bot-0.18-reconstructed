// BASELINE-1, piece 2. Research is the eleventh managed seed, and the handbook names it.
//
// WHERE IT CAME FROM. The recipe was written for the Kelley bolt case and lived on exactly one box,
// Jason's, at /home/box/sand-data/workflows/research-multi-source/SKILL.md, owned by one agent id.
// A workflow in one agent's library is that agent's; a managed seed is the product's and reaches
// every box with no fetch and no login. This suite pins the parts of the recipe that the bad run
// broke, so a later edit cannot quietly drop the rule that catches it.
//
// WHAT IT DOES NOT PIN. The wording of the prose. Every assertion below is a rule the acceptance
// question turns on: the six rules, the soft-failure triggers, the cheaper-query rung, the three
// headings of the output contract, and the worked example itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedDir = path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills");
const raw = readFileSync(path.join(seedDir, "research", "SKILL.md"), "utf8");
const body = raw.slice(raw.indexOf("\n---", 4) + 4);
const handbook = readFileSync(path.join(seedDir, "handbook-what-i-can-do", "SKILL.md"), "utf8");

/** The host cuts an injected body here and appends a pointer, so a pack over it is read half way. */
const INJECTED_BODY_LIMIT = 16_000;
/** The exact question the wave's acceptance test asks a box. */
const KELLEY = "Who carries 3/8 in. x 8 in. hot-dip galvanized hex bolts in packs of 10 or 25 "
  + "in Leander or Cedar Park, TX, at local stores?";

test("the seed is named research and carries a description the catalog can render", () => {
  assert.match(raw, /^---\n/, "the generator throws on a file with no frontmatter");
  assert.match(raw, /^name:\s*research$/m, "the frontmatter name is the directory name, because the id IS the directory");
  const description = /description: >-\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
  assert.ok(description.trim().length > 0, "a seed with no description is a catalog row that says nothing");
  // KB-1f: the name and description of every installed skill ride in every prompt, so the
  // description is what decides whether a model reaches for this file at all. Kept under the
  // host's own cap with room, and kept to the shape the other seeds use.
  assert.ok(description.replace(/\s+/g, " ").trim().length <= 1_536, "under WORKFLOW_MAX_DESCRIPTION_LENGTH");
  assert.match(description, /availability|pricing|sourcing/i, "it says what kind of question this is for");
});

test("the frontmatter names no owner, so the seed is the product's and not one person's bot", () => {
  // The copy on Jason's box carried metadata.owner with his lead agent's uuid. Managed skills have
  // no owner at all -- materializeManagedSkillFiles re-serializes from name, description and body --
  // so an owner left in the seed source would be a line that reads as true and is dropped in
  // silence. Saying it here is cheaper than the next person wondering which it is.
  assert.ok(!/owner/i.test(raw.slice(0, raw.indexOf("\n---", 4))), "no owner in the frontmatter");
  assert.ok(!/96a720b6|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw),
    "and no agent uuid anywhere in the file");
});

test("all six rules are there, numbered, and R2 forbids the universal negative outright", () => {
  for (const rule of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
    assert.match(body, new RegExp(`\\*\\*${rule}\\.`), `${rule} is a rule with its own paragraph`);
  }
  // The four the bad run broke, each pinned by the thing it forbids rather than by its wording.
  assert.match(body, /site's own search is not authoritative/i, "R1: a search box is not a catalog");
  assert.match(body, /Never assert a universal negative/i, "R2: no 'nobody carries it'");
  assert.match(body, /I couldn't find/, "R2 hands over the strongest form the answer may use");
  assert.match(body, /altitude the question was asked/i, "R4: answer what was asked");
  assert.match(body, /Every source the user named appears in your output/i, "R5: no source silently dropped");
});

test("the ask is parsed into slots before the first query, and the two skipped rows are named", () => {
  for (const slot of ["Object", "Qualifier", "Sources", "Geography", "Intent", "Done when"]) {
    assert.ok(body.includes(`| ${slot} |`), `the slot table carries ${slot}`);
  }
  assert.match(body, /\*\*Intent\*\* and \*\*Done when\*\* are the rows that get skipped/,
    "the two rows that cause the wrong answer are called out, not just listed");
});

test("a soft failure escalates like a hard one, and the cheapest escalation is a better query", () => {
  assert.match(body, /soft failure\*\* is when the tool works perfectly/i,
    "the definition is the load-bearing half: it looks identical to success");
  for (const trigger of ["Qualifier", "Geography", "Done when"]) {
    assert.ok(new RegExp(`none match the \\*\\*${trigger}\\*\\*|\\*\\*${trigger}\\*\\* row not yet satisfied`).test(body),
      `${trigger} is an escalation trigger`);
  }
  assert.match(body, /About to write any negative or absence claim/i, "and so is a negative about to be written");
  assert.match(body, /Cheapest escalation is a better query, not a bigger tool/i,
    "the cheap rung is re-queried before a dearer one is climbed");
  assert.match(body, /site:lowes\.com/, "site-scoped search is the named fix for R1");
  assert.match(body, /Format:|Vocabulary:/, "re-query by format and by vocabulary before climbing");
});

test("the output contract keeps the uncertainty section and forbids hiding it", () => {
  for (const heading of ["ANSWER", "FINDINGS", "COULDN'T ESTABLISH", "ASSUMPTIONS"]) {
    assert.ok(body.includes(heading), `the contract carries a ${heading} section`);
  }
  assert.match(body, /Qualifier match/, "the findings table has the column the bad run had no way to fail");
  assert.match(body, /COULDN'T ESTABLISH is not optional and not a failure/,
    "an answer with no uncertainty section usually hid its uncertainty");
  assert.match(body, /phone/i, "a store that could not be established comes with a way to ring it");
});

test("the Kelley worked example is kept, with the bad run and what each failure was", () => {
  assert.ok(body.includes(KELLEY), "the exact question the acceptance test asks");
  assert.match(body, /\$12\.56/, "the bad run's one price, which is what made it look like an answer");
  assert.match(body, /Nobody lists a 25-pack/, "and the universal negative it ended on");
  for (const rule of ["R4", "R2", "R5"]) {
    assert.ok(new RegExp(`\\(${rule}[,)]`).test(body), `the bad run's failure is tied back to ${rule}`);
  }
  assert.match(body, /Good run:/, "and the shape a good answer takes is spelled out beside it");
});

test("the file is inside the injection limit and carries no em dash", () => {
  assert.ok(body.length < INJECTED_BODY_LIMIT,
    `${body.length} characters against the ${INJECTED_BODY_LIMIT} the host cuts an injected body at`);
  // Jason reads an em dash as a machine wrote it. The copy on his box was full of them; this one is
  // not, and the conversion was punctuation only.
  assert.ok(!/[—–]/.test(raw), "no em dash or en dash anywhere in the seed");
});

test("the handbook's what-I-can-do block names the skill by a path the model can open", () => {
  const at = handbook.indexOf("## Finding something out");
  assert.ok(at > 0, "the pack carries a block for it");
  const block = handbook.slice(at, handbook.indexOf("\n## ", at + 4));
  for (const label of ["They ask", "True today", "Where it lives", "What I say first"]) {
    assert.ok(new RegExp(`\\*\\*${label}:\\*\\*`).test(block), `the block carries "${label}:"`);
  }
  // The model-visible alias, never the on-disk path: /home/box/sand-data is what the store holds and
  // /home/box/agent-data is the symlink the agent can actually read, the same rule KB-1f pinned.
  assert.ok(block.includes("/home/box/agent-data/managed-skills/skills/research/SKILL.md"),
    "the block hands over the path, not an id the model cannot look up");
  assert.ok(!block.includes("/home/box/sand-data"), "and never the on-disk path");
  // The three rules an owner feels the absence of, said in the pack as well as in the skill, because
  // a turn that never opens the file still has to obey them.
  assert.match(block, /never say nobody has a thing/i, "R2 is in the block");
  assert.match(block, /name every source the owner named/i, "R5 is in the block");
  assert.match(block, /answer at the height they asked/i, "R4 is in the block");
});
