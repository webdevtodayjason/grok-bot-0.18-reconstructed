// KB-1f: the installed skills an agent has actually reach its prompt.
//
// `SandRequestContextExecutor` has taken a `resolveAgentSkills` callback since the reconstruction
// and nothing ever passed one, so `agentSkills` arrived empty on every turn, the
// <available_skills> section never rendered, and no installed skill's name or description reached
// any prompt. A pack seeded by KB-1 or BOTS-4 was on disk and invisible: the only way one reached a
// turn was the standing persona spelling out its path by hand, which is why that one sentence cost
// 699 characters to name a single file.
//
// These cases drive the real chain end to end -- seeds written to a real managed-skills dir, read
// back by a real FileWorkflowStore, through the resolver, into the real prompt section builder and
// renderer -- because every link in it was already present and only the producer was missing.
//
// Two things are pinned here beyond "it renders". The catalog carries the NAME and the DESCRIPTION
// and never the body, since a body in a standing section is paid on every turn of every agent
// forever. And the path in it is the /home/box/agent-data one the model can actually open, not the
// /home/box/sand-data path the store keeps, which is the same rule the persona's handbook sentence
// and the workflows location already follow.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Staged inside the repo so `require` resolves the modules the bundle leaves external.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".agent-skill-catalog-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const entry = path.join(stage, "entry.ts");
writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(repoRoot, "source/host/runner/agent-skills-resolver.js"))};`,
  `export { FileWorkflowStore } from ${JSON.stringify(path.join(repoRoot, "source/host/workflows/workflow-store.js"))};`,
  `export { writeManagedSkillsCache } from ${JSON.stringify(path.join(repoRoot, "source/host/extensions/managed-setup/managed-skills-cache.js"))};`,
  `export { SEED_MANAGED_SKILLS } from ${JSON.stringify(path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills.gen.js"))};`,
  `export { buildAvailableSkillsPromptSection } from ${JSON.stringify(path.join(repoRoot, "source/packages/agent/prompts/user-info-available-skills.js"))};`,
  `export { renderContent } from ${JSON.stringify(path.join(repoRoot, "source/packages/prompt-jsx/render.js"))};`,
  `export { AgentType } from ${JSON.stringify(path.join(repoRoot, "source/packages/agent/utils/agent-config.js"))};`,
  `export { estimateStringTokenCount } from ${JSON.stringify(path.join(repoRoot, "source/packages/agent/utils/token-estimate.js"))};`,
  `export { createTurnLocalResourceProjection } from ${JSON.stringify(path.join(repoRoot, "source/host/runner/turn-agent-composition.js"))};`,
  `export { requestContextExecutorResource } from ${JSON.stringify(path.join(repoRoot, "source/packages/agent-exec/request-context.js"))};`,
  "",
].join("\n"), "utf8");
const built = await build({
  entryPoints: [entry],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
});
const bundlePath = path.join(stage, "agent-skill-catalog.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text, "utf8");
const {
  AGENT_SKILL_CATALOG_LIMIT, agentSkillCatalog, createAgentSkillsResolver,
  FileWorkflowStore, writeManagedSkillsCache, SEED_MANAGED_SKILLS,
  buildAvailableSkillsPromptSection, renderContent, AgentType, estimateStringTokenCount,
  createTurnLocalResourceProjection, requestContextExecutorResource,
} = createRequire(import.meta.url)(bundlePath);

/** A sand root with the real managed seeds written the way the host writes them, and one agent. */
function seededBox(options = {}) {
  const sandRoot = mkdtempSync(path.join(stage, "sand-"));
  if (options.seeds !== false) writeManagedSkillsCache(path.join(sandRoot, "managed-skills"), SEED_MANAGED_SKILLS);
  const agentDir = path.join(sandRoot, "agents", options.agentId ?? "agent-one");
  mkdirSync(agentDir, { recursive: true });
  return { sandRoot, agentDir, store: new FileWorkflowStore(agentDir, path.join(sandRoot, "workflows")) };
}

/** The prompt section exactly as the turn builds it, rendered to the text the model is sent. */
function renderCatalogSection(agentSkills) {
  const section = buildAvailableSkillsPromptSection({
    cursorRules: [],
    agentSkills,
    agentTokenLimit: 200_000,
    displayOptions: { agentType: AgentType.IDE, displaySkills: true },
  }, { readToolName: "Read" });
  return { ...section, text: section.section === undefined ? "" : renderContent(section.section) };
}

function seedSource(id) {
  return readFileSync(path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills", id, "SKILL.md"), "utf8");
}

test("a seeded pack reaches the prompt by name and description, and its body does not", () => {
  const { store } = seededBox();
  const rendered = renderCatalogSection(createAgentSkillsResolver({ store })());
  assert.match(rendered.text, /<available_skills/, "the catalog section renders at all");
  // The name. A managed skill's name IS its folder, so the name reaching the model means the path
  // reaching the model; seed-skills.gen.ts is generated from that folder and its frontmatter agrees.
  assert.match(rendered.text, /managed-skills\/skills\/handbook-what-i-can-do\/SKILL\.md/);
  // The description, whole and unshortened: five packs plus five legacy seeds sit far under budget.
  const index = SEED_MANAGED_SKILLS.find((skill) => skill.id === "handbook-what-i-can-do");
  assert.ok(index !== undefined && index.description.length > 80, "the index pack carries a real description");
  assert.ok(rendered.text.includes(index.description), "the whole description reaches the prompt");
  assert.equal(rendered.strategy, "under_budget");
  // And never the body. These are lines only the pack's own markdown has.
  assert.ok(index.body.length > 5_000, "the index pack has a body worth keeping out of the prompt");
  for (const line of index.body.split("\n").filter((line) => line.trim().length > 40).slice(0, 12)) {
    assert.ok(!rendered.text.includes(line.trim()), `the body line reached the prompt: ${line.trim().slice(0, 60)}`);
  }
  assert.ok(rendered.text.length < index.body.length, "the catalog is smaller than one pack's body");
});

test("every seeded pack is named, and each is named once", () => {
  const { store } = seededBox();
  const catalog = agentSkillCatalog(store.list());
  const ids = catalog.rows.map((row) => row.fullPath.split("/").at(-2));
  assert.deepEqual([...ids].sort(), SEED_MANAGED_SKILLS.map((skill) => skill.id).sort());
  assert.equal(new Set(ids).size, ids.length, "no pack is listed twice");
  for (const row of catalog.rows) {
    const source = seedSource(row.fullPath.split("/").at(-2));
    assert.ok(row.description.length > 0, `${row.fullPath} has no description`);
    assert.ok(source.includes(row.description.slice(0, 40)), "the description is the seed's own");
  }
});

test("an agent with no skills renders no section", () => {
  const { store } = seededBox({ seeds: false });
  const skills = createAgentSkillsResolver({ store })();
  assert.deepEqual(skills, []);
  const rendered = renderCatalogSection(skills);
  assert.equal(rendered.section, undefined, "no skills means no section, not an empty one");
  assert.equal(rendered.skillCount, 0);
  assert.equal(rendered.text, "");
});

test("a runner with no workflow store resolves to nothing rather than throwing", () => {
  assert.deepEqual(createAgentSkillsResolver({})(), []);
  assert.deepEqual(createAgentSkillsResolver({ store: { list() { throw new Error("library is gone"); } } })(), []);
});

test("a routine is a job and not a skill, and a skill switched off is not offered", () => {
  const { store } = seededBox({ seeds: false });
  store.create({ name: "Morning digest", description: "Runs on its own", body: "Summarise the inbox.", trigger: { schedule: "0 7 * * *", isEnabled: true } });
  const offered = store.create({ name: "Quote a job", description: "How we price a job", body: "Ask for the square footage first.", trigger: null });
  const hidden = store.create({ name: "Old recipe", description: "Not in use", body: "Superseded by the new one.", trigger: null });
  store.setEnabledForAgent(hidden.id, false);
  const catalog = agentSkillCatalog(store.list());
  assert.deepEqual(catalog.rows.map((row) => row.description), ["How we price a job"]);
  assert.ok(catalog.rows[0].fullPath.endsWith(`${offered.id}/SKILL.md`));
  const rendered = renderCatalogSection(createAgentSkillsResolver({ store })());
  assert.ok(!rendered.text.includes("Morning digest"));
  assert.ok(!rendered.text.includes("Not in use"));
});

test("the catalog stops at forty and the product's own packs are the ones that survive", () => {
  const { store } = seededBox();
  for (let index = 0; index < 60; index += 1) {
    store.create({ name: `Library skill ${index}`, description: `A skill the owner wrote, number ${index}`, body: `Step one for ${index}.`, trigger: null });
  }
  const catalog = agentSkillCatalog(store.list());
  assert.equal(AGENT_SKILL_CATALOG_LIMIT, 40);
  assert.equal(catalog.rows.length, 40);
  // BASELINE-1 made it eleven seeds: research joined the ten. The cap is what this case is about,
  // so the count moves with the seed roster rather than being pinned to a number of its own.
  assert.equal(catalog.offeredCount, SEED_MANAGED_SKILLS.length + 60, "every seed and sixty library skills were offered");
  const ids = catalog.rows.map((row) => row.fullPath.split("/").at(-2));
  for (const seed of SEED_MANAGED_SKILLS) assert.ok(ids.includes(seed.id), `${seed.id} was dropped by the cap`);
  const capped = [];
  const skills = createAgentSkillsResolver({ store, reportCapped: (offered, limit) => capped.push([offered, limit]) })();
  assert.equal(skills.length, 40);
  assert.deepEqual(capped, [[SEED_MANAGED_SKILLS.length + 60, 40]], "the operator is told once that the list is not the whole library");
  // Forty rows of real descriptions still fit the section's own 2%-of-context budget, so the cap
  // and the budget do not fight: nothing is shortened at the cap.
  const rendered = renderCatalogSection(skills);
  assert.equal(rendered.strategy, "under_budget");
  assert.equal(rendered.skillCount, 40);
});

test("the path handed over is the one the model can open", () => {
  const onBox = {
    id: "handbook-what-i-can-do", name: "handbook-what-i-can-do", description: "The index pack",
    body: "x", trigger: null, source: "managed", sourceRef: null, ownerAgentId: null,
    isEnabledForAgent: true, createdAt: 0, helperScripts: [],
    filePath: "/home/box/sand-data/managed-skills/skills/handbook-what-i-can-do/SKILL.md",
  };
  const catalog = agentSkillCatalog([onBox]);
  assert.deepEqual(catalog.rows, [{
    fullPath: "/home/box/agent-data/managed-skills/skills/handbook-what-i-can-do/SKILL.md",
    description: "The index pack",
  }], "the store's sand-data path is rewritten to the agent-data alias the persona also uses");
});

// The seam itself, driven rather than read: the turn projection builds the request-context executor
// from this callback, and the executor is what puts agentSkills on the RequestContext the prompt
// renders. This is the step that was empty on every turn for the whole life of the reconstruction.
test("the turn projection carries the callback into the request context", async () => {
  const { store } = seededBox();
  const projection = createTurnLocalResourceProjection({
    baseAccessor: { get() { throw new Error("no remote resource is wanted here"); } },
    subagentSessions: new Map(),
    createSubagentRunner: () => { throw new Error("no subagent is dispatched here"); },
    subagentDispatcher: {
      isRunning: () => false, allocateComputerUseWindow: () => null, freeComputerUseWindow() {}, dispatch() {},
    },
    requestContext: { resolve: () => ({ osVersion: "box", shell: "/bin/bash", timeZone: "UTC" }), resolveRules: async () => [] },
    resolveAgentSkills: createAgentSkillsResolver({ store }),
    includeTranscripts: false,
    autoReviewEnforceEnabled: false,
    shellStreamExecutor: { execute() { throw new Error("no shell here"); } },
    backgroundShellExecutor: { execute() { throw new Error("no shell here"); } },
    autoReviewGate: { assertNoPendingApproval() {} },
    actionAuditor: { record() {} },
    agentId: "agent-one",
  });
  const executor = projection.resourceAccessor.get(requestContextExecutorResource);
  const result = await executor.execute();
  assert.equal(result.result.case, "success");
  const skills = result.result.value.requestContext.agentSkills;
  assert.equal(skills.length, SEED_MANAGED_SKILLS.length, "the executor put every seed on the request context");
  const index = skills.find((skill) => skill.fullPath.includes("handbook-what-i-can-do"));
  assert.ok(index !== undefined, "the handbook index reached the request context");
  assert.ok(index.description.length > 80);
  assert.equal(index.content, "", "the body is not carried on the request context either");
  // Unset, not false: the runner treats a false completeness flag as a context to resolve again,
  // and a box with forty skills and a library of four hundred is still a complete answer.
  assert.equal(result.result.value.requestContext.agentSkillsInfoComplete, undefined);
});

// The fault KB-1f recorded was not a wrong catalog, it was a callback with no producer: the field
// and the section and the renderer were all there and nothing filled the field, so every case above
// would have passed while no agent's prompt changed. This is the case that fails if the producer is
// unplugged again.
test("the host composition actually supplies the callback", () => {
  const composition = readFileSync(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  assert.match(composition, /createAgentSkillsResolver\(\{ store: session\.workflows as AgentSkillCatalogStore \}\)/);
  assert.match(composition, /resolveAgentSkills: agentSkillsResolver/);
  const resolver = readFileSync(path.join(repoRoot, "source/host/runner/agent-skills-resolver.ts"), "utf8");
  assert.match(resolver, /agentSkillsFromWorkflows\(workflows\)/, "the existing workflow filter is the one that decides what a skill is");
  // The resolver is built where the runner is, not inside the per-turn closure: its one piece of
  // state is whether the over-the-cap notice has been said, and per-turn state says it every turn.
  const perRunner = composition.indexOf("const agentSkillsResolver = session.workflows != null");
  const perTurn = composition.indexOf("createTurnLocalResourceProjectionInput: baseAccessor =>");
  assert.ok(perRunner > 0 && perTurn > 0 && perRunner < perTurn, "the resolver is bound before the per-turn projection closure");
});

// The standing cost this row bought, measured on this Mac on 2026-09-12 with the ten seeds a box
// carries and the /home/box/agent-data paths it really uses. Before KB-1f the catalog cost zero
// because it never rendered. The ceilings are generous enough for a description edit and tight
// enough that another wave adding a pack has to look at the number.
test("the standing cost of the catalog is the measured one", () => {
  const { store } = seededBox();
  const boxRows = agentSkillCatalog(store.list()).rows.map((row) => ({
    fullPath: row.fullPath.replace(/^.*\/managed-skills\//, "/home/box/agent-data/managed-skills/"),
    description: row.description,
  }));
  const rendered = renderCatalogSection(boxRows.map((row) => ({
    ...row, content: "", environments: [], disabledEnvironments: [], globs: [], scopedTo: [], disableModelInvocation: false,
  })));
  // Measured 2026-09-12: 3,927 chars / 982 estimated tokens for ten seeds; 886 chars / 222 tokens
  // for one, so the fixed preamble is about 700 chars and each further skill about 338 chars
  // (84 tokens). BASELINE-1 added an eleventh, research, whose row is a 60-character path and a
  // 307-character description. MEASURED ON THIS MAC 2026-09-15: eleven seeds render at 4,335
  // characters, 408 more than ten did, so the ceiling below moves by that much and no more.
  assert.ok(rendered.text.length < 4_450, `${boxRows.length} seeds render at ${rendered.text.length} chars`);
  assert.ok(estimateStringTokenCount(rendered.text) < 1_120, `${boxRows.length} seeds render at ${estimateStringTokenCount(rendered.text)} estimated tokens`);
  assert.equal(rendered.strategy, "under_budget", "nothing is shortened at the seed roster's size");
});
