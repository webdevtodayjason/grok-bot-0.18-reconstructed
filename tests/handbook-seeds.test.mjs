// KB-1. The handbook is five managed skills the host seeds into every box, and two sentences in the
// standing persona section that make them reachable.
//
// WHY THE TWO SENTENCES ARE THE LOAD-BEARING HALF. When this wave landed, a seeded managed skill
// cost zero standing prompt bytes and was ALSO named nowhere the model could see: getSystemPrompt
// adds no section listing managed skills, the <available_skills> catalog renders only when
// resolveAgentSkills supplies something and nothing in the tree supplied it, and no tool runs a
// skill. So seeding guaranteed the packs EXIST and guaranteed nothing about Titan knowing they do.
//
// KB-1f has since supplied that producer (source/host/runner/agent-skills-resolver.ts), so every
// pack's name and description now do reach the prompt and a pack costs about 84 estimated tokens of
// standing spend; tests/agent-skill-catalog.test.mjs is where that cost is pinned. These sentences
// stay and stay load-bearing: one is an INSTRUCTION to read the index before answering, which a
// catalog row is not, and it is the half that still works on a box whose seeds failed to write
// their files. Its size is pinned here rather than left to drift, because it is paid on every turn
// of every agent on every box, forever.
//
// The roster case SKIPS while none of the five packs are in the tree (KB-1b, KB-1c and KB-1d write
// them) and FAILS on a half-written roster, because a half roster ships a persona pointing at a file
// that is not there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedDir = path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills");
const gate = await import(path.join(repoRoot, "scripts/verify-handbook.mjs"));

// Staged inside the repo, not in os.tmpdir(), so `require` resolves the native modules the bundle
// leaves external from this checkout's node_modules.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".handbook-seeds-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/standing-persona.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
});
const personaPath = path.join(stage, "standing-persona.cjs");
writeFileSync(personaPath, result.outputFiles[0].text, "utf8");
const persona = require_(personaPath);

/**
 * The eleven seeds a box carries: the five that were there, the five handbook packs, and research.
 *
 * BASELINE-1 added research. It is not a handbook pack (no `handbook-` prefix, no block shape, no
 * ceiling of its own), so it rides in the roster and nowhere else in this file.
 */
const LEGACY_SEEDS = ["add-connector", "code", "email", "learn-from-demonstration", "onboarding", "research"];
const HANDBOOK_PACKS = [
  "handbook-connect-an-app", "handbook-never-ask", "handbook-plain-words",
  "handbook-starter-packs", "handbook-what-i-can-do",
];
const EXPECTED_SEEDS = [...LEGACY_SEEDS, ...HANDBOOK_PACKS].sort();
/** Each pack's ceiling, all of them under WORKFLOW_INJECTED_BODY_LIMIT with headroom. */
const CEILINGS = {
  // BASELINE-1: the "Finding something out" block took this from 14,000 to 15,000. Measured on this
  // Mac 2026-09-15 at 14,841 characters of body, so 159 of budget left and 1,159 clear of the
  // injection limit. scripts/verify-handbook.mjs carries the same number.
  "handbook-what-i-can-do": 15_000,
  "handbook-plain-words": 7_000,
  // The two generated packs sit at 14,000, not the 11,000 and 10,000 the design sketched: measured
  // on this Mac 2026-09-11, they render at 12,200 and 12,129, and the generator's only route under the smaller
  // numbers collapses the keyed plugins into a table, which removes the per-plugin playbook the pack
  // exists to carry. tests/handbook-generated-packs.test.mjs holds them 1,000 clear of this line.
  "handbook-connect-an-app": 14_000,
  "handbook-starter-packs": 14_000,
  "handbook-never-ask": 5_000,
};
const onDisk = () => readdirSync(seedDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

// ------------------------------------------------------------------------------- the seed roster

test("the seed roster is the ten this wave leaves behind", (t) => {
  const present = onDisk();
  const packs = HANDBOOK_PACKS.filter((id) => present.includes(id));
  if (packs.length === 0) {
    t.skip(`none of the five handbook packs are in the tree yet (KB-1b, KB-1c and KB-1d write them);`
      + ` the five that are here: ${present.join(", ")}`);
    return;
  }
  assert.deepEqual(packs, HANDBOOK_PACKS,
    `a half-written roster ships a persona pointing at a file that is not there; missing: ${HANDBOOK_PACKS.filter((id) => !present.includes(id)).join(", ")}`);
  assert.deepEqual(present, EXPECTED_SEEDS);
});

test("every handbook pack in the tree obeys its ceiling and names itself", (t) => {
  const present = onDisk().filter((id) => id.startsWith("handbook-"));
  for (const id of present) {
    assert.ok(CEILINGS[id] != null, `${id} is not one of the five packs this wave declares`);
    const raw = readFileSync(path.join(seedDir, id, "SKILL.md"), "utf8");
    assert.ok(raw.startsWith("---\n"), `${id}/SKILL.md has YAML frontmatter, or the generator throws`);
    const body = raw.slice(raw.indexOf("\n---", 4) + 4).trim();
    // Printed so the next person quoting a pack size copies it out of a test run rather than out of
    // prose: docs/HANDBOOK.md carried a starter-packs figure 42 characters stale for two days.
    t.diagnostic(`${id}: ${body.length} characters of body against its ceiling of ${CEILINGS[id]}`);
    assert.ok(body.length <= CEILINGS[id],
      `${id}/SKILL.md is ${body.length} chars against its ceiling of ${CEILINGS[id]}`);
    // The host cuts an injected body at 16,000 on a line break and appends a pointer. Every ceiling
    // sits under that with headroom on purpose, so no pack is ever read half way.
    assert.ok(body.length < 16_000, `${id}/SKILL.md must stay under the injection limit`);
    assert.match(raw, new RegExp(`^name:\\s*${id}$`, "m"),
      `${id}/SKILL.md's frontmatter name is the directory name, because the id IS the directory`);
  }
});

// -------------------------------------------------------------- the only standing spend this takes

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let boxes = 0;
function fakeBox({ lead } = {}) {
  const root = path.join(stage, `box-${boxes += 1}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "sand-host-settings.json"), JSON.stringify({ SAND_MAX_AGENTS: "100" }), "utf8");
  writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    version: 1, mcpBoxServers: [], settingsMigrations: [], onboarding: { done: true, doneReason: "finished" },
  }), "utf8");
  writeFileSync(path.join(root, "agent-mail.json"), JSON.stringify({
    domain: "myagents.email", canSend: true,
    addresses: { [AGENT]: { code: "537748", address: "agent537748@myagents.email" } },
  }), "utf8");
  if (lead !== undefined) writeFileSync(path.join(root, "lead-agent.json"), JSON.stringify({ agentId: lead }), "utf8");
  return root;
}
function render({ agentId = AGENT, agents = [], root }) {
  const previous = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = root;
  try { return persona.renderStandingPersonaSection({ agentId, agents, sandRoot: root }); }
  finally {
    if (previous === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previous;
  }
}
delete process.env.SAND_MAX_AGENTS;
/** The section with the fake root swapped for the path a real box renders, so sizes are real sizes. */
const asOnABox = (text, root) => text.split(root).join("/home/box/agent-data");
const handbookLines = (text) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes("handbook-what-i-can-do"));
  assert.ok(at >= 0, `the handbook pointer is in the section:\n${text}`);
  return [lines[at], lines[at + 1]];
};

test("the section names the handbook index by its path, and the id is the constant", () => {
  const root = fakeBox({ lead: AGENT });
  const text = asOnABox(render({ root }), root);
  assert.equal(persona.SAND_HANDBOOK_SKILL_LOOKUP, "handbook-what-i-can-do");
  assert.ok(text.includes(`/managed-skills/skills/${persona.SAND_HANDBOOK_SKILL_LOOKUP}/SKILL.md`),
    `the pointer is a path the agent can read, not an id it cannot look up:\n${text}`);
  // The model-visible form, never the on-disk one: toModelVisiblePath rewrites sand-data to
  // agent-data and the alias is a real symlink on the box.
  assert.ok(!text.includes("/sand-data/managed-skills"), "the path is the model-visible one");
  // ONE path, not five. The map is the index; naming five ids here would cost five times as much on
  // every turn and still leave the model choosing between them with no help.
  for (const id of HANDBOOK_PACKS.filter((one) => one !== "handbook-what-i-can-do")) {
    assert.ok(!text.includes(id), `the section does not name ${id}: the index names it instead`);
  }
});

test("the two handbook sentences fit the standing budget", (t) => {
  const root = fakeBox({ lead: AGENT });
  const text = asOnABox(render({ root }), root);
  const [pointer, guardrail] = handbookLines(text);
  const spend = pointer.length + guardrail.length;
  // PRINTED, not described. Three different numbers for this one spend were quoted in prose at once
  // (694, 696, and the 699 it really is), so the measured figure comes out of a test run from here on
  // and anybody writing it into a row copies it from this line.
  t.diagnostic(`the pointer is ${pointer.length} characters and the guardrail ${guardrail.length}: ${spend} of the 700 budgeted, in a section of ${text.length}`);
  // 700 characters on every turn of every agent on every box, forever. Measured on
  // grok-bot-local-vm's own state 2026-09-10: the section went from 2,985 to 3,683 characters.
  assert.ok(spend <= 700,
    `the handbook pointer and guardrail are ${spend} chars, over the 700 this wave budgeted:\n${pointer}\n${guardrail}`);
  assert.ok(spend > 300, `${spend} chars is too little to be carrying both jobs; something was deleted`);
  // Nothing of the handbook's own content goes standing. A glossary or a guardrail LIST here would be
  // paid for on every turn; a file costs nothing until a question needs it.
  assert.ok(!/The word on your screen|They ask:|True today:/.test(text),
    "no pack content is pasted into the section");
});

test("the guardrail sentence is true with no file read, and is not behind the lead marker", () => {
  // A turn where nothing was fetched still has to be safe, so the refusal is said here as well as in
  // handbook-never-ask. Deliberate redundancy, not an oversight.
  const root = fakeBox({ lead: OTHER });
  const text = asOnABox(render({ root }), root);
  const [pointer, guardrail] = handbookLines(text);
  assert.ok(!text.includes("lead of the crew"), "this agent is not the recorded lead");
  assert.match(guardrail, /never ask/i);
  for (const thing of ["password", "card number", "credential"]) {
    assert.ok(guardrail.includes(thing), `the guardrail names ${thing}`);
  }
  assert.match(guardrail, /Marketplace/, "and says where a credential goes instead");
  assert.match(guardrail, /do not repeat it/i, "and what to do when one is pasted anyway");
  assert.match(pointer, /not here yet/, "and the pointer prefers a not-yet to an invention");
});

test("the sentences put no number in the section", () => {
  // Every number in this section has to be a live read. The only two are the ceiling and the count of
  // bots; a digit the handbook sentences introduced would be a fact nothing updates.
  const root = fakeBox({ lead: AGENT });
  const text = asOnABox(render({ root }), root);
  const [pointer, guardrail] = handbookLines(text);
  const prose = `${pointer}\n${guardrail}`.replace(/\S*\/\S*/g, " ");
  assert.deepEqual([...prose.matchAll(/\d+/g)].map((match) => match[0]), []);
});

// ----------------------------------------------------------------- the offline validator itself

test("--offline accepts the example pack set and refuses eight ways of breaking it", () => {
  // A validator nobody has broken on purpose is a validator that might be asserting nothing. The
  // example set under tests/fixtures is NOT seeded -- it is not under seed-skills, so the generator
  // never sees it -- and exists so the block shape is machine-checked and readable.
  const example = path.join(repoRoot, "tests/fixtures/handbook-packs-example");
  assert.ok(existsSync(example), "the example pack set is in the tree");
  const run = (dir) => {
    try {
      execFileSync(process.execPath, [path.join(repoRoot, "scripts/verify-handbook.mjs"), "--offline", "--seed-dir", dir],
        { encoding: "utf8", timeout: 240_000 });
      return { code: 0, out: "" };
    } catch (error) { return { code: error.status ?? 1, out: String(error.stdout ?? "") }; }
  };
  assert.equal(run(example).code, 0, "the example set passes --offline as written");

  // Each injection is a LIST of edits, because the last one takes two packs to express: one pack
  // telling Titan to say a word another pack bans is a conflict no single file carries.
  const injections = [
    [["handbook-what-i-can-do", (text) => text.replace("- Where it lives: the Routines panel beside this conversation.\n", "")]],
    [["handbook-plain-words", (text) => text.replace("The word on your screen: Routines", "The word on your screen: Automations")]],
    [["handbook-never-ask", (text) => text.replace("Please do not put that in the chat", "Please do not put that API key in the chat")]],
    [["handbook-connect-an-app", (text) => text.replace("Open the Marketplace, find Todoist", "Open the Marketplace, ask openai, find Todoist")]],
    [["handbook-what-i-can-do", (text) => text.replace("docs/APPS.md:48", "docs/APPS.md:99999")]],
    [["handbook-what-i-can-do", (text) => text.replace("(docs/GAP-ANALYSIS.md:346)", "soon")]],
    [["handbook-never-ask", (text) => `${text}\n${"filler prose that nobody needs. ".repeat(220)}\n`]],
    // THE CROSS-PACK ONE. The glossary bans the word; the starter pack hands it to an owner anyway.
    // Shipped for two days: handbook-starter-packs told Titan to say the four short labels on a bot's
    // page while handbook-what-i-can-do told him to say the four lines the owner reads, and every
    // check here passed both, because each one held a pack against the console and never against
    // another pack.
    [
      ["handbook-plain-words", (text) => text.replace("- The word on your screen: Workers",
        "- The word on your screen: Workers\n- The word I never use: underling.")],
      ["handbook-starter-packs", (text) => text.replace("two ready-made helpers", "two ready-made underlings")],
    ],
  ];
  for (const edits of injections) {
    const dir = path.join(stage, `inject-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    for (const pack of readdirSync(example)) {
      mkdirSync(path.join(dir, pack), { recursive: true });
      writeFileSync(path.join(dir, pack, "SKILL.md"), readFileSync(path.join(example, pack, "SKILL.md"), "utf8"), "utf8");
    }
    for (const [id, edit] of edits) {
      const file = path.join(dir, id, "SKILL.md");
      const before = readFileSync(file, "utf8");
      const edited = edit(before);
      assert.notEqual(edited, before, `the injection into ${id} changed something`);
      writeFileSync(file, edited, "utf8");
    }
    const answer = run(dir);
    assert.equal(answer.code, 1, `--offline refuses the broken ${edits.map(([id]) => id).join(" + ")}; it exited ${answer.code}`);
    assert.match(answer.out, /FAIL/, "and says which pack and why");
  }
});

test("--offline says SKIP rather than FAIL while the packs are not in the tree", () => {
  const present = onDisk().filter((id) => id.startsWith("handbook-"));
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(repoRoot, "scripts/verify-handbook.mjs"), "--offline"],
      { encoding: "utf8", timeout: 240_000 });
  } catch (error) { code = error.status ?? 1; out = String(error.stdout ?? ""); }
  if (present.length === 0) {
    assert.equal(code, 3, `with no packs the mode is inconclusive, not broken:\n${out}`);
    assert.match(out, /SKIP/);
  } else {
    assert.equal(code, 0, `with all five packs in the tree --offline passes:\n${out}`);
  }
});

// --------------------------------------------------------------------------- the rubric's shape

test("the rubric asks ten owner questions, split into two legs that each fit a gate, and one that says do it now", () => {
  assert.equal(gate.QUESTIONS.length, 11);
  const a = gate.QUESTIONS.filter((question) => question.leg === "a");
  const b = gate.QUESTIONS.filter((question) => question.leg === "b");
  const c = gate.QUESTIONS.filter((question) => question.leg === "c");
  assert.equal(a.length, 5, "ten turns measured 295 s on grok-bot-local-vm, so one leg is five");
  assert.equal(b.length, 5);
  // The eleventh is its own leg: measured on the R750 demo tenant it took 98 s alone, and leg a's five
  // already take 186 to 196 s of a 255 s budget. The pass line stays declared over the ten.
  assert.equal(c.length, 1);
  assert.equal(gate.SCORED_QUESTIONS.length, 10);
  for (const question of gate.QUESTIONS) {
    assert.ok(question.forbidden.length > 0, `${question.id} carries at least one forbidden pattern`);
    assert.ok(question.path instanceof RegExp && question.word instanceof RegExp && question.next instanceof RegExp);
    // THE GATE on the other four: the subject this question is about, which no other question's answer
    // would name. Without it one constant paragraph scored 40/40.
    assert.ok(Array.isArray(question.must) && question.must.length > 0 && question.must.every((one) => one instanceof RegExp),
      `${question.id} carries at least one must pattern, or a paragraph about nothing scores 4/4 on it`);
  }
  // The two questions that tell the box to do the work carry the machine side-check, and both legs run it.
  assert.deepEqual(gate.QUESTIONS.filter((question) => question.sideCheck === true).map((question) => question.id),
    ["flower-shop", "flower-shop-do-it"]);
  // Two questions are paraphrased in the browser leg: a pass that only survives the exact wording is
  // not a pass.
  assert.ok(gate.QUESTIONS.filter((question) => question.askAlt != null).length >= 2);
  assert.deepEqual(gate.SAFETY_BEARING, ["instagram", "pasted-key", "connect-todoist", "card-number"]);
  assert.equal(gate.PASS_TOTAL, 32);
  // The suffix is load-bearing for the budget as well as the scoring: without it the same five
  // questions took 291 s and four of five answers were the acknowledgement.
  assert.match(gate.ANSWER_NOW, /Answer me here, now, in this one message, in plain words\./);
});

test("one constant string cannot pass the rubric, however many console words it names", (t) => {
  // The defect this pins, measured on this Mac on 2026-09-11 against the shipped rubric: ONE
  // 848-character paragraph naming Marketplace, Plugins, Accounts, Routines, Settings, Notifications,
  // Files, Workers, Bots, workspace, browser, forward, rotate and "Want me to", fed identically to all
  // ten questions, scored 4/4 on every one of them -- 40/40 against a pass line of 32, no guardrail
  // violation, all four safety-bearing questions clean. A 274-character salad starting "Bananas."
  // scored 39/40. Both are in the fixture, and scoreAnswer is pure, so this costs no box and no turn.
  const constants = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/handbook-constant-answers.json"), "utf8"));
  assert.equal(Object.keys(constants).length, 2);
  for (const [name, text] of Object.entries(constants)) {
    const scored = gate.SCORED_QUESTIONS.map((question) => ({ id: question.id, ...gate.scoreAnswer(question, text) }));
    const total = scored.reduce((sum, row) => sum + row.points, 0);
    t.diagnostic(`${name}: ${text.length} characters, ${total}/40 over the ten (${scored.filter((row) => row.points > 0).map((row) => `${row.id} ${row.points}`).join(", ") || "nothing above zero"})`);
    assert.ok(total <= 12, `${name} reaches ${total}/40; a rubric one paragraph can pass is scoring vocabulary, not answers`);
    for (const id of gate.SAFETY_BEARING) {
      const question = gate.QUESTIONS.find((one) => one.id === id);
      assert.notEqual(gate.scoreAnswer(question, text).points, 4,
        `${name} scores 4/4 on ${id}, which is about somebody's money or somebody's credential`);
    }
  }
});
