// ONBOARD-1, item 2. A fresh box's first agent is Titan.
//
// There is exactly one place a box that has never held an agent gets one: `createFallbackSession`,
// which `ensureSession` reaches when it finds no agent directories at all. Everywhere else a name
// arrives from a profile the caller supplied, so naming the first agent here is the only change
// that cannot rename somebody's existing bot.
//
// Note what it does NOT do: `createFallbackSession` goes straight to `materializeSession` rather
// than through `mintAgentSession`, so it never sets introduction-pending and `kickstartAgent`
// returns false on the agent it makes. Titan's first turn is dispatched by the console (or by the
// gateway's `startOnboarding`), not by the existing kickstart.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".onboarding-first-agent-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  delete process.env.SAND_DATA_ROOT;
});

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const agents = await load("source/shared/agents/agents.ts", "agents");
const materialization = await load("source/host/extensions/session/session-materialization.ts", "session-materialization");

const settingsRoot = mkdtempSync(path.join(tmpdir(), "first-agent-settings-"));
roots.push(settingsRoot);
process.env.SAND_DATA_ROOT = settingsRoot;

const freshRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "first-agent-roster-"));
  roots.push(root);
  return root;
};

const storeFor = (root) => {
  const disposals = [];
  const store = new materialization.SandSessionMaterialization({
    ctx: {}, rootDir: root,
    createBlobWorkerPool: () => ({ closeAll: async () => {} }),
    createAgentStore: () => ({
      getFullConversation: async () => ({}),
      dispose: async () => {},
    }),
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: () => true,
    getAgentDir: (agentId) => path.join(root, agentId),
    readActiveAgentId: () => null,
  });
  return { store, disposals };
};

const nameOf = (root, agentId) =>
  JSON.parse(readFileSync(path.join(root, agentId, "profile.json"), "utf8"));

const close = (session) => { try { session.db.close(); } catch {} };

test("the first agent on an empty box is Titan, with Titan's face", async () => {
  const root = freshRoot();
  const { store } = storeFor(root);
  const session = await store.createFallbackSession(async () => { throw new Error("nothing to adopt"); });
  try {
    const profile = nameOf(root, session.id);
    assert.equal(profile.name, agents.SAND_FIRST_AGENT_NAME);
    assert.equal(profile.name, "Titan");
    // mascot-crew.js reads a stored face as `titan:<Name>`; index 0 of the crew is Titan's own.
    assert.equal(profile.avatarShape, "titan:Titan");
  } finally {
    close(session);
    await store.closeWorkerPool();
  }
});

test("a box that already holds an agent still mints the default name", async () => {
  // The guard that keeps this from renaming anybody: the Titan profile is only supplied when the
  // box is genuinely empty. A second agent minted down this path is a plain new bot.
  const root = freshRoot();
  mkdirSync(path.join(root, "00000000-0000-4000-8000-000000000001"), { recursive: true });
  const { store } = storeFor(root);
  const session = await store.createFallbackSession(async () => { throw new Error("nothing to adopt"); });
  try {
    assert.equal(nameOf(root, session.id).name, agents.SAND_DEFAULT_AGENT_NAME);
    assert.equal(nameOf(root, session.id).name, "New Bot");
  } finally {
    close(session);
    await store.closeWorkerPool();
  }
});

test("nothing renames an agent that already exists", async () => {
  const root = freshRoot();
  const { store } = storeFor(root);
  const first = await store.createFallbackSession(async () => { throw new Error("nothing to adopt"); });
  const firstId = first.id;
  close(first);
  // Someone renamed it. A later fallback must leave that alone -- it adopts or mints, it never
  // rewrites a profile it did not just create.
  writeFileSync(
    path.join(root, firstId, "profile.json"),
    JSON.stringify({ name: "Chief of Staff", description: "", title: "", avatarShape: "", avatarColor: "" }),
  );
  const second = await store.createFallbackSession(async () => { throw new Error("nothing to adopt"); });
  try {
    assert.equal(nameOf(root, firstId).name, "Chief of Staff");
    assert.notEqual(second.id, firstId);
    assert.equal(nameOf(root, second.id).name, "New Bot");
  } finally {
    close(second);
    await store.closeWorkerPool();
  }
});

test("the first agent gets a real store on disk, like any other", async () => {
  const root = freshRoot();
  const { store } = storeFor(root);
  const session = await store.createFallbackSession(async () => { throw new Error("nothing to adopt"); });
  try {
    assert.equal(existsSync(path.join(root, session.id, "store.db")), true);
    assert.equal(existsSync(path.join(root, session.id, "settings.json")), true);
  } finally {
    close(session);
    await store.closeWorkerPool();
  }
});
