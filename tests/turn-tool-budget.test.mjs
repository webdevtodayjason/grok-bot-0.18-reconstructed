// TOOLS-33. A turn may make at most SAND_TURN_TOOL_BUDGET tool calls before the host refuses the
// rest, and this file is what that cap does when it is hit. withTurnToolBudget wraps one tool
// against a shared counter: calls 1..budget run the inner tool unchanged, and call budget+1 together
// with every later call do not reach the inner tool at all, and instead throw the refuse text so the
// engine's own error path turns it into the tool's error result. The counter is shared, so two tools
// drawn from the same build share one budget, and a fresh build starts at zero.
//
// The cap is per turn, for every agent and every skill, and it never looks at what skill is active:
// a subagent turn builds its own toolset and therefore its own counter.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// CJS, loaded from a staged file, the same way turn-toolset-projection.test.mjs loads the module.
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/tools/turn-toolset.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"],
  logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".turn-tool-budget-test-"));
const bundlePath = path.join(stage, "turn-toolset.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
after(() => rmSync(stage, { recursive: true, force: true }));
const mod = createRequire(import.meta.url)(bundlePath);

// A tool whose error path is easy to read: serializeError returns the error message under a known
// key, so the engine's refusal (which routes our refuse text through this tool's serializeError) is
// shaped exactly like the tool's real error, and a private `inner` object records whether the real
// tool was ever reached.
const makeTool = (name) => {
  const inner = { calls: 0 };
  const tool = {
    name,
    toolIdentifier: name,
    execute: async () => {
      inner.calls += 1;
      return { ok: name };
    },
    serializeError: (error) => ({
      errorCase: true,
      message: error instanceof Error ? error.message : String(error),
    }),
  };
  return { tool, inner };
};

// The exact refuse text a budgeted turn sends back, with the budget substituted. The test pins this
// literal independently of the wrapper, so a slip in either side fails the suite.
const refusalText = (budget) =>
  `Tool budget for this turn is spent (${budget} calls). Stop calling tools and write your answer now with what you have; say plainly what you could not establish.`;

// A refused call is a plain error carrying the refuse text; the engine turns it into the tool's error
// result, and the refusal must match this exactly.
const isRefusal = (budget) => (error) =>
  error instanceof Error && error.message === refusalText(budget);

test("budget 3 lets three calls through and refuses the fourth and fifth with the exact text", async () => {
  const budget = 3;
  const counter = mod.createTurnToolBudgetCounter();
  const { tool, inner } = makeTool("Shell");
  const wrapped = mod.withTurnToolBudget(tool, budget, counter);

  for (let call = 1; call <= 3; call += 1) {
    const result = await wrapped.execute();
    assert.deepEqual(result, { ok: "Shell" }, `call ${call} ran the inner tool`);
  }
  assert.equal(inner.calls, 3, "the inner tool ran exactly the budgeted number of times");

  for (let call = 4; call <= 5; call += 1) {
    await assert.rejects(
      () => wrapped.execute(),
      isRefusal(budget),
      `call ${call} refused with the exact text`,
    );
  }
  assert.equal(inner.calls, 3, "the inner tool never ran for a refused call");
});

test("the refused call never reaches the inner execute", async () => {
  const counter = mod.createTurnToolBudgetCounter();
  let hitInner = false;
  const tool = {
    name: "Shell",
    execute: async () => {
      hitInner = true;
      return { ok: true };
    },
    serializeError: (error) => (error instanceof Error ? error.message : String(error)),
  };
  const wrapped = mod.withTurnToolBudget(tool, 1, counter);

  await wrapped.execute(); // call 1, within budget, runs
  assert.equal(hitInner, true, "the first call reached the inner tool");
  await assert.rejects(() => wrapped.execute(), isRefusal(1), "call 2 refused");
  assert.equal(hitInner, true, "the refused call did not reach the inner tool");
});

test("two different tools share the one counter", async () => {
  const budget = 3;
  const counter = mod.createTurnToolBudgetCounter();
  const shell = makeTool("Shell");
  const read = makeTool("Read");
  const shellTool = mod.withTurnToolBudget(shell.tool, budget, counter);
  const readTool = mod.withTurnToolBudget(read.tool, budget, counter);

  await shellTool.execute();
  await shellTool.execute();
  await readTool.execute();
  assert.equal(counter.calls, 3, "the counter counts calls across both tools");

  // The very next call, from either tool, is the fourth against the same counter and is refused.
  await assert.rejects(() => readTool.execute(), isRefusal(budget), "the fourth call across tools is refused");
  await assert.rejects(() => shellTool.execute(), isRefusal(budget), "the fifth call across tools is refused");
  assert.equal(read.inner.calls, 1, "the read tool's inner ran once, then was refused");
  assert.equal(shell.inner.calls, 2, "the shell tool's inner ran twice, then was refused");
});

test("a fresh wrapper set starts at zero", async () => {
  const counter = mod.createTurnToolBudgetCounter();
  assert.equal(counter.calls, 0, "a fresh counter has done no calls");
  const { tool, inner } = makeTool("Shell");
  const wrapped = mod.withTurnToolBudget(tool, 2, counter);

  const first = await wrapped.execute();
  assert.deepEqual(first, { ok: "Shell" }, "the first call on a fresh set runs rather than refuses");
  assert.equal(inner.calls, 1);
});

test("the first refusal logs one line naming the agent and the budget; later refusals do not log", async () => {
  const budget = 2;
  const counter = mod.createTurnToolBudgetCounter();
  const logLines = [];
  const log = (agentId, amount) => logLines.push(`${agentId} ${amount}`);
  const { tool } = makeTool("Shell");
  const wrapped = mod.withTurnToolBudget(tool, budget, counter, {
    agentId: "agent-under-test",
    log,
  });

  await wrapped.execute();
  await wrapped.execute();
  await assert.rejects(() => wrapped.execute(), isRefusal(budget), "call 3 refused");
  await assert.rejects(() => wrapped.execute(), isRefusal(budget), "call 4 refused");
  assert.equal(logLines.length, 1, "only the first refusal logged");
  assert.ok(logLines[0].startsWith("agent-under-test 2"), `the log names the agent and budget (got ${JSON.stringify(logLines[0])})`);
});

test("resolveTurnToolBudget reads the setting from the environment", () => {
  const previous = process.env.SAND_TURN_TOOL_BUDGET;
  process.env.SAND_TURN_TOOL_BUDGET = "7";
  try {
    assert.equal(mod.resolveTurnToolBudget(), 7);
  } finally {
    if (previous === undefined) delete process.env.SAND_TURN_TOOL_BUDGET;
    else process.env.SAND_TURN_TOOL_BUDGET = previous;
  }
});

test("a setting of 0 is invalid, not unlimited, and drops to the 150 default", () => {
  const previous = process.env.SAND_TURN_TOOL_BUDGET;
  process.env.SAND_TURN_TOOL_BUDGET = "0";
  try {
    assert.equal(mod.resolveTurnToolBudget(), 150);
  } finally {
    if (previous === undefined) delete process.env.SAND_TURN_TOOL_BUDGET;
    else process.env.SAND_TURN_TOOL_BUDGET = previous;
  }
});