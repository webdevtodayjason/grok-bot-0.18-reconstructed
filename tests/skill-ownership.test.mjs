// Agent-owned skills beside global ones, driven through the real store.
//
// Every skill on a box used to live in one library at sand-data/workflows and every agent got all
// of them; the only per-agent state was an enable flag. So a skill Titan wrote for himself during a
// turn was silently in everybody's library, and no surface could say whose it was.
//
// Ownership is one field: WorkflowRecord.ownerAgentId, persisted in the SKILL.md frontmatter as
// metadata.owner. null means global (in every agent's library, exactly as before); an agent id
// means the skill belongs to that agent and the host offers it to no one else. These cases pin the
// things that have to hold for that to be worth trusting -- the split in what each agent is
// offered, the refusal to touch another agent's skill through any write, the round trip through the
// file (the file IS the record, so an ordinary edit must not lose or invent an owner), and the
// writer behind update_state, which is how an agent saves a skill in the first place.
//
// Every build here runs BEFORE the first test() call on purpose: the runner starts the registered
// tests at the first await, and an `after` hook that fires while a later top-level await is still
// running would delete the staging directory out from under it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".skill-ownership-test-"));
const require_ = createRequire(import.meta.url);
async function load(entry, filename) {
  const built = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const file = path.join(stage, filename);
  writeFileSync(file, built.outputFiles[0].text, "utf8");
  return require_(file);
}
const { FileWorkflowStore } = await load("source/host/workflows/workflow-store.ts", "workflow-store.cjs");
const { createSandAgentState } = await load("source/host/extensions/memory/agent-state.ts", "agent-state.cjs");

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
});

// The real layout: <sandRoot>/workflows is the library and <sandRoot>/agents/<agentId> is the agent
// directory, which is why the store can read its own id off the directory name.
function box() {
  const root = mkdtempSync(path.join(tmpdir(), "sand-skill-ownership-"));
  roots.push(root);
  const globalDir = path.join(root, "workflows");
  mkdirSync(globalDir, { recursive: true });
  const storeFor = (agentId) => {
    const agentDir = path.join(root, "agents", agentId);
    mkdirSync(agentDir, { recursive: true });
    return new FileWorkflowStore(agentDir, globalDir);
  };
  return { root, globalDir, storeFor };
}
const spec = (name, extra = {}) => ({ name, description: `use when ${name} applies`, body: `Do the ${name} thing.`, trigger: null, ...extra });
const idsOf = (store) => store.listAll().filter((workflow) => workflow.source === "workflow").map((workflow) => workflow.id);

test("an owned skill is listed for its owner and for nobody else; a global one for both", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice"), bob = storeFor("agent-bob");

  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));
  const shared = alice.create(spec("Everyone"));

  assert.equal(owned.ownerAgentId, "agent-alice", "a create that names an owner records it");
  assert.equal(shared.ownerAgentId, null, "a create with no owner is global, the way every skill used to be");
  assert.deepEqual(idsOf(alice).sort(), [owned.id, shared.id].sort(), "the owner is offered both");
  assert.deepEqual(idsOf(bob), [shared.id], "the other agent is offered only the global one");
  assert.equal(bob.get(owned.id), null, "and cannot even read it by id");
  assert.equal(alice.get(owned.id).ownerAgentId, "agent-alice");
});

test("an owned skill is enabled for its owner from the moment it is saved", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice");
  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));
  assert.equal(owned.isEnabledForAgent, true, "no second step to turn on your own skill");
  assert.equal(alice.list().some((workflow) => workflow.id === owned.id), true, "so it reaches the model's own list");
  alice.setEnabledForAgent(owned.id, false);
  assert.equal(alice.get(owned.id).isEnabledForAgent, false, "the per-agent switch still works on it");
  assert.equal(alice.list().some((workflow) => workflow.id === owned.id), false);
});

test("no write reaches another agent's skill", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice"), bob = storeFor("agent-bob");
  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));

  assert.equal(bob.update(owned.id, spec("Bob's rewrite")), null, "no rewrite");
  assert.equal(bob.setEnabledForAgent(owned.id, false), null, "no enable");
  assert.equal(bob.setOwner(owned.id, null), null, "no hand-over: only the owner can make it global");
  assert.equal(bob.remove(owned.id), false, "no delete");
  assert.equal(existsSync(owned.filePath), true, "and the file is still there afterwards");
  assert.equal(alice.get(owned.id).body, "Do the Alice only thing.", "untouched");
});

test("Make global hands the skill to the box, and the file is the record", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice"), bob = storeFor("agent-bob");
  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));

  assert.match(readFileSync(owned.filePath, "utf8"), /owner: "agent-alice"/, "ownership lives in the SKILL.md frontmatter");

  const promoted = alice.setOwner(owned.id, null);
  assert.equal(promoted.ownerAgentId, null);
  assert.equal(bob.get(owned.id)?.ownerAgentId, null, "and now the other agent has it too");
  assert.doesNotMatch(readFileSync(owned.filePath, "utf8"), /owner:/, "the frontmatter key is gone, not blanked");
});

test("an ordinary edit keeps the owner it found, and never invents one", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice"), bob = storeFor("agent-bob");
  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));
  const shared = alice.create(spec("Everyone"));

  assert.equal(alice.update(owned.id, spec("Alice only", { body: "Rewritten." })).ownerAgentId, "agent-alice", "editing your own does not lose it");
  // The one that would have been silent: a global skill edited by an agent must not become its own.
  assert.equal(bob.update(shared.id, { ...spec("Everyone"), body: "Rewritten by Bob." }).ownerAgentId, null);
  assert.equal(alice.get(shared.id).body, "Rewritten by Bob.", "the edit still landed");
});

test("deleting an agent takes its own skills and leaves the box's alone", () => {
  const { storeFor } = box();
  const alice = storeFor("agent-alice"), bob = storeFor("agent-bob");
  const owned = alice.create(spec("Alice only", { ownerAgentId: "agent-alice" }));
  const shared = alice.create(spec("Everyone"));

  assert.deepEqual(alice.releaseOwnedSkills(), [owned.id]);
  assert.equal(existsSync(owned.filePath), false, "the folder goes with the agent");
  assert.deepEqual(idsOf(bob), [shared.id], "the global one stays: it belongs to the box");
});

// The writer behind update_state, which is how an agent saves a skill for itself (and how the
// learn-from-demonstration recipe writes what it learned).
//
// Measured on the Mac box on 2026-09-05, before this change: a probe agent told to save a skill
// with update_state answered "The tool answered with an error, verbatim: Error: Cannot read
// properties of undefined (reading 'text')" -- and the skill was on disk anyway. The tool reads
// `detail` off a success (runner/agent-state.ts) and hands it to buildSuccessResult(output.text);
// this writer answered { ok, message }, so `detail` was undefined and EVERY successful update_state
// write -- memory, routines, profile, avatar, skills -- came back to the model as that error.
function stateWriter() {
  const written = [];
  const port = {
    create(workflowSpec) { written.push({ op: "create", spec: workflowSpec }); return { id: "saved-skill", name: workflowSpec.name }; },
    update(id, workflowSpec) { written.push({ op: "update", id, spec: workflowSpec }); return { id, name: workflowSpec.name }; },
    remove() { return true; },
  };
  const state = createSandAgentState({
    agentId: "agent-alice", agentDir: path.join(tmpdir(), "unused"), sandRoot: path.join(tmpdir(), "unused"),
    memory: { addMemory: () => null, removeMemoryByContent: () => false },
    membership: { read: () => new Set(), join: () => true, leave: () => true },
    channels: { remove: () => false },
    automations: { upsert: () => null, update: () => null, setEnabled: () => null, get: () => null, remove: () => false },
    workflows: port,
    readProfile: () => ({}), writeProfile: () => {}, writeSettings: () => {},
  });
  return { state, written };
}

test("update_state's writer answers in the shape the tool reads", async () => {
  const { state } = stateWriter();
  const outcome = await state.writeWorkflow({ name: "Probe", description: "use when probing", body: "Do it." });
  assert.equal(outcome.ok, true);
  assert.equal(typeof outcome.detail, "string", "the tool reads .detail and hands it to buildSuccessResult(output.text)");
  assert.match(outcome.detail, /Probe/);
  // Merge note: the trunk's STATE-1 fix (fd28fd6) keeps `message` beside `detail`/`reason` so this
  // module's own callers have one name to read; what matters here is that the two never disagree.
  assert.equal(outcome.message, outcome.detail, "message no longer says something different from what the tool reads");
});

test("a skill an agent saves for itself is stamped with the agent's id", async () => {
  const { state, written } = stateWriter();
  await state.writeWorkflow({ name: "Mine", description: "use when mine applies", body: "Do it." });
  assert.deepEqual(written.map((entry) => entry.op), ["create"]);
  assert.equal(written[0].spec.ownerAgentId, "agent-alice");
  // A rewrite passes no owner at all, so the file's own metadata.owner decides -- editing a global
  // skill must not quietly claim it for whoever edited it.
  await state.writeWorkflow({ id: "saved-skill", name: "Mine", description: "d", body: "Do it again." });
  assert.equal("ownerAgentId" in written[1].spec, false);
});
