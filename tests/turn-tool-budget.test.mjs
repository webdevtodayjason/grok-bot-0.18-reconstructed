// TOOLS-33. A turn may make at most SAND_TURN_TOOL_BUDGET tool calls before the host refuses the
// rest, and this file is what that cap does when it is hit. withTurnToolBudget wraps one tool
// against a shared counter: calls 1..budget run the inner tool unchanged, and call budget+1 together
// with every later call do not reach the inner tool at all, and instead throw the refuse text so the
// engine's own error path turns it into the tool's error result. The counter is shared, so two tools
// drawn from the same build share one budget, and a fresh turn starts at zero.
//
// The counter spans the turn, not the build: the runner rebuilds the toolset on every model step, so
// the turn owns the counter and hands it to each build. The last two cases here are the ones that
// measure that, and they are the ones a green suite was missing while the cap did not bind.
//
// The cap is per turn, for every agent and every skill, and it never looks at what skill is active:
// a subagent turn is its own turn with its own counter.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".turn-tool-budget-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
// CJS, loaded from a staged file, the same way turn-toolset-projection.test.mjs loads the module.
// The per-turn handoff comes along too: the last cases drive the real chain instead of handing the
// wrapper a counter the test owns, which is the only way to see where the counter is really born.
const entry = path.join(stage, "entry.ts");
writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(repoRoot, "source/host/runner/tools/turn-toolset.js"))};`,
  `export { createTurnAgentToolsHandoff } from ${
    JSON.stringify(path.join(repoRoot, "source/host/runner/turn-agent-composition.js"))
  };`,
  "",
].join("\n"), "utf8");
const result = await build({
  entryPoints: [entry],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"],
  logLevel: "silent",
});
const bundlePath = path.join(stage, "turn-toolset.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
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
/**
 * The wiring, not just the wrapper. Every case above hands `withTurnToolBudget` a counter the test
 * created, which proves the wrapper honours a shared counter and nothing at all about whether the
 * counter it is handed in production spans a turn. It did not: the counter was created inside
 * `buildTurnTools`, and the runner calls that once per model STEP (LOOP-2), so every step handed
 * the turn a fresh count. A live box ran seventy-one tool calls against a ceiling of thirty and
 * refused none of them while the whole suite stayed green. These two cases drive the real chain --
 * `toolsGenerator` is exactly what the runner calls before each model call -- so the counter's
 * lifetime is measured rather than assumed.
 */
const handoffForTurn = () => mod.createTurnAgentToolsHandoff({
  turn: {
    autoReviewModes: {
      hostShell: "off", boxShell: "off", mcp: "off", computer: "off",
      automationWrite: "off", cloudAgent: "off", subagentLaunch: "off",
    },
  },
  toolHost: {
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: false,
    getConversationId: () => "agent-under-test",
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    spotlightEnabled: () => false,
    factories: {},
    factoryProvider: {
      createSendMessageToolInputs: (turn) => ({
        dependencies: {
          getIngestAttachment: () => undefined,
          onSendMessage: () => "m1",
          ...(turn.sendBudget === undefined ? {} : { turnSendBudget: turn.sendBudget }),
        },
      }),
    },
  },
});

/** One model step: the runner asks for a toolset, and the step calls tools out of that build. */
const buildStep = (handoff) => {
  const tools = handoff.toolsGenerator({}).getAllTools();
  const tool = tools.find((entry) => entry.name === "SendMessage");
  assert.ok(tool, `the step built a SendMessage tool (got ${tools.map((t) => t.name).join(", ")})`);
  return tool;
};

/**
 * Calls the real tool with no arguments, which is all this needs: the budget refuses before the
 * inner tool is ever reached, so an allowed call is "anything except the refusal" (here the tool's
 * own TypeError) and a refused call carries the refuse text exactly.
 */
const callOnce = async (tool) => {
  try {
    await tool.execute();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The setting is read per build, so it has to be in place before the step asks for its toolset. */
const withBudgetSetting = async (value, run) => {
  const previous = process.env.SAND_TURN_TOOL_BUDGET;
  process.env.SAND_TURN_TOOL_BUDGET = value;
  const originalInfo = console.info;
  const logged = [];
  console.info = (...args) => logged.push(args.join(" "));
  try {
    return await run(logged);
  } finally {
    console.info = originalInfo;
    if (previous === undefined) delete process.env.SAND_TURN_TOOL_BUDGET;
    else process.env.SAND_TURN_TOOL_BUDGET = previous;
  }
};

test("the count carries from one step's build to the next, because the turn owns the counter", async () => {
  await withBudgetSetting("2", async (logged) => {
    const handoff = handoffForTurn();
    const firstStep = buildStep(handoff);
    assert.notEqual(await callOnce(firstStep), refusalText(2), "call one of two is allowed");
    // The next model step of the SAME turn: a second build, and the count has to come with it.
    const secondStep = buildStep(handoff);
    assert.notEqual(await callOnce(secondStep), refusalText(2), "call two of two is allowed");
    assert.equal(await callOnce(secondStep), refusalText(2), "call three is past the ceiling");
    // And a tool from the earlier build is just as spent: one counter, not one per build.
    assert.equal(await callOnce(firstStep), refusalText(2), "the first build's tool is spent too");
    assert.equal(
      logged.filter((line) => line.includes("[sand][turn-tool-budget]")).length,
      1,
      "one log line for the turn, naming the cap that held",
    );
  });
});

test("a fresh handoff is a fresh turn, so the next turn starts at zero", async () => {
  await withBudgetSetting("1", async () => {
    const spent = buildStep(handoffForTurn());
    assert.notEqual(await callOnce(spent), refusalText(1), "the turn's one call is allowed");
    assert.equal(await callOnce(spent), refusalText(1), "the turn's budget is spent");
    const nextTurn = buildStep(handoffForTurn());
    assert.notEqual(await callOnce(nextTurn), refusalText(1), "the next turn starts at zero");
  });
});
