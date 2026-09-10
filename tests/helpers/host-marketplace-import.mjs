// The host's catalog import, bundled once for whatever suite needs it.
//
// TITAN-CATALOG-1 moved the Add sequence out of ui/machine-room/bot-setup.js and into
// source/host/extensions/marketplace/marketplace-bot-import.ts, so the console's press and Titan's
// request are two doors onto one import. Two suites need to reach that module: the host suite that
// pins its order, and tests/community-bots.test.mjs, whose case plans a SHIPPED catalog row's apps
// and used to reach the console function that no longer exists.
//
// It is a helper rather than a copy in each of them because the bundling is fiddly — esbuild to
// CJS with the three native modules left external, staged inside the tree so `require` can resolve
// them — and because bundling the same 20 MB module twice in one run is the kind of thing that
// makes people stop running the suite.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Staged in the tree rather than os.tmpdir() so `require` walks up to this checkout's node_modules
// for the three modules the bundle leaves external. `.tmp-*` is ignored by git.
const stage = mkdtempSync(path.join(repoRoot, ".tmp-host-marketplace-"));
process.on("exit", () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* going away anyway */ } });
const require_ = createRequire(import.meta.url);

async function bundle(entry, name) {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
}

/** The import module: the verb, the sequence, and the pure readers the plan is built from. */
export const hostMarketplaceImport = await bundle(
  "source/host/extensions/marketplace/marketplace-bot-import.ts",
  "marketplace-bot-import.cjs",
);

/** The catalog itself, so a case can be driven off a real row rather than a fixture. */
export const marketplaceCatalog = await bundle(
  "source/shared/marketplace/catalog.ts",
  "catalog.cjs",
);

/**
 * A BOX, not a fixture. Two suites drive the real import against it: the one that pins the
 * sequence, and the one that pins what a bot READS BACK off the report it produces. It lives here
 * rather than in either of them because a report hand-written in one suite is exactly how the
 * counts in the agent's own sentence read 0 for a week while the console's card read them right.
 *
 * A box with a roster, a shared library, routines and a memory store, recording every call in
 * order. The method names are the host doors the import goes through, which is what the order
 * assertions read.
 */
export function fakeMarketplaceBox({ agents = [], library = [], installed = [] } = {}) {
  const calls = [];
  const roster = agents.map((name, index) => ({ id: `a${index}`, name }));
  const shared = library.map((name, index) => ({ id: `w${index}`, name, source: "workflow" }));
  const memories = new Map();
  const automations = new Map();
  const probed = [];
  let next = roster.length;
  const record = (method, args) => { calls.push({ method, args }); };
  return {
    calls, roster, shared, memories, automations, probed,
    methods: () => calls.map((call) => call.method),
    argsFor(method) { return calls.filter((call) => call.method === method).map((call) => call.args); },

    async listAgents() { record("listAgents", {}); return roster.map((agent) => ({ ...agent })); },
    async createAgent(args) {
      record("createAgent", args);
      const agent = { id: `a${next += 1}`, name: args.name, description: args.description };
      roster.push(agent);
      memories.set(agent.id, []);
      automations.set(agent.id, []);
      return { agent };
    },
    async deleteAgent(id) {
      record("deleteAgent", { id });
      const at = roster.findIndex((agent) => agent.id === id);
      if (at >= 0) roster.splice(at, 1);
      memories.delete(id);
      automations.delete(id);
      return { ok: true };
    },
    async addAgentMemories(id, seeds) {
      record("addAgentMemories", { id, memories: seeds });
      const held = memories.get(id) ?? [];
      const added = [];
      const rejected = [];
      for (const raw of seeds) {
        const value = String(raw).replace(/\s+/g, " ").trim();
        // The store's own rule, in one line: over the cap it is refused, never shortened.
        if (value.length > 500) { rejected.push({ text: value, why: "too long" }); continue; }
        if (held.some((row) => row.content === value)) continue;
        held.push({ id: `m${held.length}`, content: value, createdAt: 1, kind: "log" });
        added.push(value);
      }
      memories.set(id, held);
      return { added, duplicates: seeds.length - added.length - rejected.length, rejected };
    },
    async getAgentMemories(id) { record("getAgentMemories", { id }); return (memories.get(id) ?? []).map((row) => ({ ...row })); },
    async getAgentWorkflows(id) { record("getAgentWorkflows", { id }); return shared.map((row) => ({ ...row })); },
    async importAgentWorkflowText(id, markdown, name) {
      record("importAgentWorkflowText", { id, markdown, name });
      shared.push({ id: name, name, source: "workflow" });
      return { result: { imported: [name], skipped: [] } };
    },
    async deleteAgentWorkflow(id, workflowId) {
      record("deleteAgentWorkflow", { id, workflowId });
      const at = shared.findIndex((row) => row.id === workflowId);
      if (at >= 0) shared.splice(at, 1);
      return { ok: true };
    },
    async createAgentAutomation(id, spec) {
      record("createAgentAutomation", { id, spec });
      const held = automations.get(id) ?? [];
      held.push({ id: `r${held.length}`, name: spec.name, prompt: spec.prompt, trigger: spec.trigger, isEnabled: spec.isEnabled === true });
      automations.set(id, held);
      return { ok: true };
    },
    async getAgentAutomations(id) { record("getAgentAutomations", { id }); return (automations.get(id) ?? []).map((row) => ({ ...row })); },
    async kickstartAgent(id) { record("kickstartAgent", { id }); return { isIntroductionInFlight: true }; },
    // Never a real probe in a test: a machine that happens to carry a binary on its PATH must not
    // decide the assertion.
    async isPluginInstalled(pluginId) { probed.push(pluginId); return installed.includes(pluginId); },
  };
}
