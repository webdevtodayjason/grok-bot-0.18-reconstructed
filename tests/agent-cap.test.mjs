// AGENTS-CAP-2. A box holds Titan plus thirty-nine by default (it was twelve until 2026-09-08, then a
// hundred for a day; Jason settled on forty on 2026-09-09 because flat coordination holds to about
// fifty and TEAMS-1 does not exist). The super admin raises a workspace from its client row, which
// writes SAND_MAX_AGENTS into that box, so the tests below separate the DEFAULT from a roster SIZE:
// the hundred-bot rosters are fake populations that must still refuse, not a claim about the cap.
//
// Three things had to be true and only the first was. (1) The ceiling was 50, declared twice in
// two files that were not wired to each other. (2) Groups were counted, so a box with rooms in it
// hit the ceiling early. (3) `isSandAgentLimitError` compared the error's MESSAGE against a
// constant no thrown error ever carried -- shared/agents/agents.ts said "50 is the maximum" while
// the error the host actually threw, declared in session-materialization.ts, said "Agent limit of
// 50 reached". So the two callers that exist to swallow a limit -- `tryEnsureSession` and the
// post-delete fallback -- rethrew it instead. These cases pin all three, plus the refusal wording
// a person actually reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".agent-cap-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  delete process.env.SAND_DATA_ROOT;
  delete process.env.SAND_MAX_AGENTS;
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
const boxSetting = await load("source/host/sand-box-setting.ts", "sand-box-setting");
const materialization = await load("source/host/extensions/session/session-materialization.ts", "session-materialization");
const session = await load("source/host/extensions/session/agent-session.ts", "agent-session");

// A settings root of this suite's own, pinned per case: the module reads SAND_DATA_ROOT on every
// call, and another suite in the same process would otherwise win.
const settingsRoot = mkdtempSync(path.join(tmpdir(), "agent-cap-settings-"));
roots.push(settingsRoot);
const useSettingsRoot = () => { process.env.SAND_DATA_ROOT = settingsRoot; };
const writeHostSettings = (value) =>
  writeFileSync(path.join(settingsRoot, "sand-host-settings.json"), JSON.stringify(value));

/** A roster on disk: `bots` plain agent directories and `groups` carrying a group config. */
const rosterRoot = (bots, groups = 0) => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-cap-roster-"));
  roots.push(root);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let n = 0;
  for (let i = 0; i < bots; i += 1) mkdirSync(path.join(root, id(n++)), { recursive: true });
  for (let i = 0; i < groups; i += 1) {
    const dir = path.join(root, id(n++));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "group.json"), JSON.stringify({ version: 1, memberIds: ["x"] }));
  }
  return root;
};

const storeFor = (root) => new materialization.SandSessionMaterialization({
  ctx: {}, rootDir: root,
  createBlobWorkerPool: () => { throw new Error("not needed"); },
  createAgentStore: () => { throw new Error("not needed"); },
  createMemoryStore: () => ({}),
  resolveUserTimeZone: () => undefined,
  agentExists: () => true,
  getAgentDir: (agentId) => path.join(root, agentId),
  readActiveAgentId: () => null,
});

test("the store the gateway holds can count this box's bots", async () => {
  // The bug: getAgentCapacity asked `sessionStore?.countCapAgents?.() ?? 0`, and that method
  // lived only on the materialization inside the store, not on the store itself. So the optional
  // call answered undefined, the `?? 0` turned that into a number, and a box holding eight bots
  // reported nought -- "0 of 12" on the Add button beside a full roster.
  const root = rosterRoot(8, 1);
  const store = new session.SandAgentSessionStore(root, () => undefined, {
    createMaterialization: () => storeFor(root),
  });
  assert.equal(typeof store.countCapAgents, "function", "the gateway reaches the count through this");
  assert.equal(await store.countCapAgents(), 8, "the room on this box is not one of the bots");
});

test("the default ceiling is Titan plus thirty-nine", () => {
  assert.equal(agents.SAND_DEFAULT_MAX_AGENTS, 40);
});

test("the refusal is plain words and names what to do about it", () => {
  assert.equal(
    agents.sandAgentLimitMessage(40),
    "This workspace holds Titan and 39 more bots. Remove one to add another.",
  );
  assert.equal(new agents.SandAgentLimitError(40).message, agents.SAND_AGENT_LIMIT_MESSAGE);
  // No em dash, no jargon, no "cap" or "limit exceeded".
  assert.doesNotMatch(agents.SAND_AGENT_LIMIT_MESSAGE, /[—–]|limit|cap|quota|maximum/i);
});

test("the refusal follows the ceiling an operator sets", () => {
  assert.equal(
    agents.sandAgentLimitMessage(5),
    "This workspace holds Titan and 4 more bots. Remove one to add another.",
  );
});

test("a limit error is recognised by the callers that exist to swallow it", () => {
  // The bug: this used to match on the message, and the error the host threw carried a different
  // one, so every real limit error escaped as a 500 instead of the graceful path.
  assert.equal(agents.isSandAgentLimitError(new agents.SandAgentLimitError()), true);
  assert.equal(agents.isSandAgentLimitError(new materialization.SandAgentLimitError()), true,
    "the session store throws the same class now, not a second one with its own message");
  assert.equal(agents.isSandAgentLimitError(new Error("something else")), false);
});

test("SAND_MAX_AGENTS moves the ceiling on a live box, without a recreate", () => {
  useSettingsRoot();
  assert.equal(boxSetting.resolveSandMaxAgents(), 40, "no override, the default");
  writeHostSettings({ SAND_MAX_AGENTS: "20" });
  assert.equal(boxSetting.resolveSandMaxAgents(), 20);
  writeHostSettings({ settings: { SAND_MAX_AGENTS: "4" } });
  assert.equal(boxSetting.resolveSandMaxAgents(), 4, "the nested shape is read too");
  // AGENTS-CAP-2. This is the door the super admin's client row writes through, and the value it
  // writes is a STRING: the reader takes a value only when typeof is "string", so a JSON number is
  // ignored in silence and the box falls back to the default. The three live R750 boxes carry
  // "100" here, which is why the default coming down to 40 cannot move a workspace already set.
  writeHostSettings({ SAND_MAX_AGENTS: "100" });
  assert.equal(boxSetting.resolveSandMaxAgents(), 100, "a raised workspace keeps its own number");
  writeHostSettings({ SAND_MAX_AGENTS: 100 });
  assert.equal(boxSetting.resolveSandMaxAgents(), 40, "a number rather than a string is not read");
});

test("a nonsense ceiling is ignored rather than locking the box out", () => {
  useSettingsRoot();
  for (const bad of ["0", "-3", "abc", "13.5", ""]) {
    writeHostSettings({ SAND_MAX_AGENTS: bad, filler: bad });
    assert.equal(boxSetting.resolveSandMaxAgents(), 40, `"${bad}" is not a ceiling`);
  }
});

test("the environment still wins over the file", () => {
  useSettingsRoot();
  writeHostSettings({ SAND_MAX_AGENTS: "4" });
  process.env.SAND_MAX_AGENTS = "7";
  try {
    assert.equal(boxSetting.resolveSandMaxAgents(), 7);
  } finally {
    delete process.env.SAND_MAX_AGENTS;
  }
});

// The hundred here is a roster SIZE, not the ceiling: a fake population well over the default that
// must refuse the next bot. It stays at a hundred through the AGENTS-CAP-2 change on purpose, so
// the test still covers a roster larger than the ceiling rather than one that merely equals it.
test("a fake roster of a hundred bots refuses the next one", async () => {
  useSettingsRoot();
  writeHostSettings({ note: "no override here" });
  const store = storeFor(rosterRoot(100));
  assert.equal(await store.countCapAgents(), 100);
  assert.equal(await store.isAgentCapReached(), true);
  await assert.rejects(
    () => store.mintAgent(async () => "should never run"),
    (error) => {
      assert.equal(agents.isSandAgentLimitError(error), true);
      // The refusal names the ceiling IN FORCE, not the roster it counted: forty here, because
      // this box carries no SAND_MAX_AGENTS of its own.
      assert.equal(error.message, "This workspace holds Titan and 39 more bots. Remove one to add another.");
      return true;
    },
  );
});

// AGENTS-CAP-2, the other half of the same door: a workspace the super admin raised keeps its own
// number, and the refusal it prints is that number rather than the product's default.
test("a raised workspace refuses at its own ceiling, and says so", async () => {
  useSettingsRoot();
  writeHostSettings({ SAND_MAX_AGENTS: "100" });
  const store = storeFor(rosterRoot(100));
  assert.equal(await store.isAgentCapReached(), true);
  await assert.rejects(
    () => store.mintAgent(async () => "should never run"),
    (error) => {
      assert.equal(error.message, "This workspace holds Titan and 99 more bots. Remove one to add another.");
      return true;
    },
  );
  const roomy = storeFor(rosterRoot(50));
  assert.equal(await roomy.isAgentCapReached(), false, "fifty bots is under a raised ceiling of a hundred");
});

test("twelve bots still has room for one more", async () => {
  useSettingsRoot();
  writeHostSettings({ note: "still no override" });
  const store = storeFor(rosterRoot(12));
  assert.equal(await store.isAgentCapReached(), false);
  assert.equal(await store.mintAgent(async () => "minted"), "minted");
});

test("groups do not count against it", async () => {
  useSettingsRoot();
  writeHostSettings({ note: "default ceiling" });
  // Twelve bots and six rooms: eighteen directories, twelve bots. Under the old count this box
  // was over the ceiling and could not add a single bot.
  const store = storeFor(rosterRoot(12, 6));
  assert.equal(await store.countOwnedAgents(), 18, "eighteen directories on disk");
  assert.equal(await store.countCapAgents(), 12, "twelve of them are bots");
  assert.equal(await store.isAgentCapReached(), false);
});

test("a group is minted even when the box is over its ceiling", async () => {
  useSettingsRoot();
  writeHostSettings({ note: "default ceiling" });
  const store = storeFor(rosterRoot(100));
  assert.equal(await store.isAgentCapReached(), true);
  assert.equal(
    await store.mintAgent(async () => "room", { isExemptFromAgentCap: true }),
    "room",
    "a room is not a bot, so the bots' ceiling cannot refuse one",
  );
});

test("the Mac dev box, as measured, is comfortably under", async () => {
  // grok-bot-local-vm on 2026-09-07: listAgents returned 8 agents plus 1 group.
  useSettingsRoot();
  writeHostSettings({ note: "default ceiling" });
  const store = storeFor(rosterRoot(8, 1));
  assert.equal(await store.countCapAgents(), 8);
  assert.equal(await store.isAgentCapReached(), false);
});
