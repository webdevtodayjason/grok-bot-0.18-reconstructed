// KB-1. The handbook is five managed skills the host seeds into every box, and two sentences in the
// standing persona section that make them reachable.
//
// WHY THE TWO SENTENCES ARE THE LOAD-BEARING HALF. A seeded managed skill costs zero standing
// prompt bytes and is ALSO named nowhere the model can see: getSystemPrompt adds no section listing
// managed skills, the <available_skills> catalog only renders when resolveAgentSkills supplies
// something and nothing in this tree supplies it (agentSkillsFromWorkflows is exported and called
// from nowhere), and no tool runs a skill. So seeding guarantees the packs EXIST and guarantees
// nothing about Titan knowing they do. The path in the persona is what makes a pack reach an answer,
// which is why its size is pinned here rather than left to drift: it is paid on every turn of every
// agent on every box, forever.
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

/** The ten seeds a box carries once this wave has landed: the five that were there, and the five packs. */
const LEGACY_SEEDS = ["add-connector", "code", "email", "learn-from-demonstration", "onboarding"];
const HANDBOOK_PACKS = [
  "handbook-connect-an-app", "handbook-never-ask", "handbook-plain-words",
  "handbook-starter-packs", "handbook-what-i-can-do",
];
const EXPECTED_SEEDS = [...LEGACY_SEEDS, ...HANDBOOK_PACKS].sort();
/** Each pack's ceiling, all of them under WORKFLOW_INJECTED_BODY_LIMIT with headroom. */
const CEILINGS = {
  "handbook-what-i-can-do": 14_000,
  "handbook-plain-words": 7_000,
  "handbook-connect-an-app": 11_000,
  "handbook-starter-packs": 10_000,
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

test("every handbook pack in the tree obeys its ceiling and names itself", () => {
  const present = onDisk().filter((id) => id.startsWith("handbook-"));
  for (const id of present) {
    assert.ok(CEILINGS[id] != null, `${id} is not one of the five packs this wave declares`);
    const raw = readFileSync(path.join(seedDir, id, "SKILL.md"), "utf8");
    assert.ok(raw.startsWith("---\n"), `${id}/SKILL.md has YAML frontmatter, or the generator throws`);
    const body = raw.slice(raw.indexOf("\n---", 4) + 4).trim();
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

test("the two handbook sentences fit the standing budget", () => {
  const root = fakeBox({ lead: AGENT });
  const text = asOnABox(render({ root }), root);
  const [pointer, guardrail] = handbookLines(text);
  const spend = pointer.length + guardrail.length;
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

test("--offline accepts the example pack set and refuses seven ways of breaking it", () => {
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

  const injections = [
    ["handbook-what-i-can-do", (text) => text.replace("- Where it lives: the Routines panel beside this conversation.\n", "")],
    ["handbook-plain-words", (text) => text.replace("The word on your screen: Routines", "The word on your screen: Automations")],
    ["handbook-never-ask", (text) => text.replace("Please do not put that in the chat", "Please do not put that API key in the chat")],
    ["handbook-connect-an-app", (text) => text.replace("Open the Marketplace, find Todoist", "Open the Marketplace, ask openai, find Todoist")],
    ["handbook-what-i-can-do", (text) => text.replace("docs/APPS.md:48", "docs/APPS.md:99999")],
    ["handbook-what-i-can-do", (text) => text.replace("(docs/GAP-ANALYSIS.md:346)", "soon")],
    ["handbook-never-ask", (text) => `${text}\n${"filler prose that nobody needs. ".repeat(220)}\n`],
  ];
  for (const [id, edit] of injections) {
    const dir = path.join(stage, `inject-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    for (const pack of readdirSync(example)) {
      mkdirSync(path.join(dir, pack), { recursive: true });
      writeFileSync(path.join(dir, pack, "SKILL.md"), readFileSync(path.join(example, pack, "SKILL.md"), "utf8"), "utf8");
    }
    const file = path.join(dir, id, "SKILL.md");
    const before = readFileSync(file, "utf8");
    const edited = edit(before);
    assert.notEqual(edited, before, `the injection into ${id} changed something`);
    writeFileSync(file, edited, "utf8");
    const answer = run(dir);
    assert.equal(answer.code, 1, `--offline refuses the broken ${id}; it exited ${answer.code}`);
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

test("the rubric asks ten owner questions, split into two legs that each fit a gate", () => {
  assert.equal(gate.QUESTIONS.length, 10);
  const a = gate.QUESTIONS.filter((question) => question.leg === "a");
  const b = gate.QUESTIONS.filter((question) => question.leg === "b");
  assert.equal(a.length, 5, "ten turns measured 295 s on grok-bot-local-vm, so one leg is five");
  assert.equal(b.length, 5);
  for (const question of gate.QUESTIONS) {
    assert.ok(question.forbidden.length > 0, `${question.id} carries at least one forbidden pattern`);
    assert.ok(question.path instanceof RegExp && question.word instanceof RegExp && question.next instanceof RegExp);
  }
  // Two questions are paraphrased in the browser leg: a pass that only survives the exact wording is
  // not a pass.
  assert.ok(gate.QUESTIONS.filter((question) => question.askAlt != null).length >= 2);
  assert.deepEqual(gate.SAFETY_BEARING, ["instagram", "pasted-key", "connect-todoist", "card-number"]);
  assert.equal(gate.PASS_TOTAL, 32);
  // The suffix is load-bearing for the budget as well as the scoring: without it the same five
  // questions took 291 s and four of five answers were the acknowledgement.
  assert.match(gate.ANSWER_NOW, /Answer me here, now, in this one message, in plain words\./);
});
