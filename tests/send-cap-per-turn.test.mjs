// LOOP-2: the send cap and the duplicate suppressor count per turn, not per step.
//
// The runner asks its toolsGenerator for a toolset once per MODEL STEP, so SendMessage is rebuilt
// several times inside one turn. While the counters lived in the tool's own closure, every step
// handed the model a fresh cap of twenty and forgot the previous message entirely -- which is why
// one turn was measured delivering thirty sends before any cap existed, and why a cap living in the
// tool would still have let a looping model spend twenty per step forever. These cases drive the
// real tool the way the host does: one turn is a sequence of steps, each step builds its own tool
// from the same per-turn dependencies.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".send-cap-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const entry = path.join(stage, "entry.ts");
// The tool needs a real Context to open its spans, so the entry hands back both.
writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(repoRoot, "source/host/runner/tools/send-message-tool.js"))};`,
  `export { createContext } from ${JSON.stringify(path.join(repoRoot, "source/packages/context/core.js"))};`,
  "",
].join("\n"), "utf8");
const result = await build({
  entryPoints: [entry],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const bundlePath = path.join(stage, "send-message-tool.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const { createSendMessageTool, createTurnSendBudget, createContext } =
  createRequire(import.meta.url)(bundlePath);

const ctx = createContext();
// The runner's own handler: it runs the tool body and records the completed call.
const interactionHandler = {
  emitPartialToolCall() {},
  async executeToolCall(context, _initial, _id, execute, complete) {
    const output = await execute(context);
    complete(output);
    return output;
  },
};
async function* argsOf(text) {
  yield JSON.stringify({ type: "text", content: text });
}

/**
 * A turn, as the host builds one: dependencies carrying a single budget, and a step() that builds
 * the tool again the way toolsGenerator does before every model call.
 */
function startTurn() {
  const delivered = [];
  const dependencies = {
    getIngestAttachment: () => undefined,
    turnSendBudget: createTurnSendBudget(),
    onSendMessage: message => {
      delivered.push(message);
      return `m${delivered.length}`;
    },
  };
  let calls = 0;
  const step = () => {
    const tool = createSendMessageTool(dependencies);
    return async text => {
      calls += 1;
      const output = await tool.execute(ctx, interactionHandler, argsOf(text), {
        toolCallId: `tc${calls}`,
      });
      return output.result.case === "error"
        ? { refused: output.result.value.error }
        : { sent: output.result.value.messageId };
    };
  };
  return { delivered, step };
}

/** Every refusal also writes the host log line the evidence gate greps for. */
async function collectWarnings(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return lines;
}

test("twenty-one sends across two steps of one turn: the twenty-first is refused", async () => {
  const turn = startTurn();
  await collectWarnings(async () => {
    const first = turn.step();
    for (let i = 0; i < 15; i += 1) {
      assert.equal((await first(`step one, message ${i}`)).refused, undefined);
    }
    assert.equal(turn.delivered.length, 15);
    // A new step, a new tool. The budget is the turn's, so it carries the fifteen already spent.
    const second = turn.step();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await second(`step two, message ${i}`)).refused, undefined);
    }
    const over = await second("step two, message 5");
    assert.match(over.refused ?? "", /Send cap reached: 20 messages/);
  });
  assert.equal(turn.delivered.length, 20);
});

test("a new turn starts at zero", async () => {
  const spent = startTurn();
  await collectWarnings(async () => {
    const step = spent.step();
    for (let i = 0; i < 20; i += 1) await step(`message ${i}`);
    assert.match(((await step("one too many")).refused) ?? "", /Send cap reached/);
  });
  assert.equal(spent.delivered.length, 20);
  const fresh = startTurn();
  assert.equal((await fresh.step()("first message of the next turn")).refused, undefined);
  assert.equal(fresh.delivered.length, 1);
});

test("the same message repeated across a step boundary is suppressed, a new one is not", async () => {
  const turn = startTurn();
  assert.equal((await turn.step()("standing by")).refused, undefined);
  const next = turn.step();
  await collectWarnings(async () => {
    assert.match(((await next("standing by")).refused) ?? "", /already delivered a moment ago/);
  });
  assert.equal((await next("actually, here is the result")).refused, undefined);
  assert.equal(turn.delivered.length, 2);
});

test("a refusal is never silent: the model is told and the host log carries a send-cap line", async () => {
  const turn = startTurn();
  const first = turn.step();
  for (let i = 0; i < 20; i += 1) await first(`message ${i}`);
  const lines = await collectWarnings(async () => {
    const refused = await turn.step()("one too many");
    assert.match(refused.refused ?? "", /Stop sending and finish/);
  });
  assert.equal(lines.filter(line => line.includes("[sand][send-cap]")).length, 1);
});

test("a tool built with no turn budget still caps itself, so an unwired caller is never uncapped", async () => {
  const delivered = [];
  const tool = createSendMessageTool({
    getIngestAttachment: () => undefined,
    onSendMessage: message => { delivered.push(message); return `m${delivered.length}`; },
  });
  await collectWarnings(async () => {
    for (let i = 0; i < 21; i += 1) {
      await tool.execute(ctx, interactionHandler, argsOf(`message ${i}`), { toolCallId: `tc${i}` });
    }
  });
  assert.equal(delivered.length, 20);
});
