// SUBAGENT-1. A background subagent that ran nothing must not be reported as done, and the parent
// must never be handed its own prompt as the result.
//
// Reports 46 to 50 and 53, from two workspaces: a Task subagent is dispatched, the wrapper says
// completed, and nothing happened. No file written, no search run, and "the only result delivered
// was the subagent echoing my own prompt back verbatim". On beta-35 the subagent directories hold a
// schema-only store, zero transcript entries and no audit ledger at all, so those turns never ran.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".subagent-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const entry = path.join(stage, "entry.ts");
writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(repoRoot, "source/host/runner/subagent-runtime.js"))};`,
  `export { buildSubagentRevivalPrompt } from ${JSON.stringify(path.join(repoRoot, "source/host/extensions/transcript/completion-revivals.js"))};`,
  `export { deriveBackgroundSubagentTitle } from ${JSON.stringify(path.join(repoRoot, "source/host/runner/background-work.js"))};`,
  "",
].join("\n"), "utf8");
const built = await build({
  entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
  target: "es2022", external: ["jsonc-parser"], logLevel: "silent",
});
const bundlePath = path.join(stage, "subagent.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text, "utf8");
const mod = createRequire(import.meta.url)(bundlePath);

const PROMPT = "Search the web for the capital city of Iceland and write it to /workspace/iceland.txt";

/** Drives one background subagent to settlement and hands back what the parent was told. */
async function runOne({ text, toolCalls }) {
  const runtime = mod.createSubagentRuntime({
    getConversationId: () => "parent-agent",
    resolveBoxId: () => "box-1",
    emitAsyncTasksChanged: () => {},
    computerUse: { freeWindow: () => {} },
  });
  let completion = null;
  runtime.setBackgroundSubagentHandler((row) => { completion = row; });
  runtime.sessions.set("child-1", {
    getObservedToolCallCount: () => toolCalls,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => null,
    getResolvedOutline: async () => [],
    run: async () => ({ text, aborted: false }),
    interrupt: () => {},
  });
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-1",
    subagentType: "generalPurpose",
    toolCallId: "call-1",
    prompt: PROMPT,
    run: async () => ({ text, aborted: false }),
  });
  await runtime.drainBackgroundSubagents();
  const listed = runtime.listSubagents().find((row) => row.subagentId === "child-1");
  return { completion, status: listed?.status, title: listed?.title };
}

test("a subagent that produced no text and called no tool is not done", async () => {
  const { completion, status } = await runOne({ text: "", toolCalls: 0 });
  assert.equal(status, "error", "the registry must not call this done");
  assert.equal(completion.status, "error", "and the parent must not be told it completed");
  assert.equal(completion.result, mod.NEVER_RAN_RESULT);
  assert.match(completion.result, /produced no output/);
  assert.match(completion.result, /Treat it as not done/);
});

test("the parent is never handed the prompt back as the result", async () => {
  const { completion, title } = await runOne({ text: "", toolCalls: 0 });
  // The title IS the prompt, by design, for display. The result must not be.
  assert.equal(title, mod.deriveBackgroundSubagentTitle(PROMPT));
  assert.ok(!completion.result.includes("capital city of Iceland"),
    `the result quoted the prompt: ${JSON.stringify(completion.result.slice(0, 80))}`);
  // And the revival block the parent actually reads frames the title as the request, not the answer.
  const revival = mod.buildSubagentRevivalPrompt([{
    title: completion.title, subagentType: "generalPurpose", status: completion.status, result: completion.result,
  }]);
  assert.match(revival, /The background task you asked for/);
  assert.match(revival, /What went wrong:/);
  const at = revival.indexOf(completion.title);
  assert.ok(at > 0 && revival.slice(0, at).includes("you asked for"),
    "the prompt appears only after the words that make it the request");
});

test("text alone is enough: a subagent that answered without a tool is done", async () => {
  const { completion, status } = await runOne({ text: "The capital is Reykjavik.", toolCalls: 0 });
  assert.equal(status, "done");
  assert.equal(completion.status, "completed");
  assert.equal(completion.result, "The capital is Reykjavik.");
});

test("a tool call alone is enough: a subagent that worked but said nothing is done", async () => {
  const { completion, status } = await runOne({ text: "", toolCalls: 2 });
  assert.equal(status, "done", "it wrote a file and said nothing, which is a real outcome");
  assert.equal(completion.status, "completed");
  assert.match(completion.result, /without producing any text output/);
  assert.notEqual(completion.result, mod.NEVER_RAN_RESULT);
});

test("the child's run shell reads its own conversation, not the parent's session", () => {
  // A source check, because the composition this line sits in needs the whole host to build. What
  // it pins is small and exact: makeRunShell has taken a shellConversationId since it was written,
  // and the body used to ignore it and return the parent's session id, which is why a child turn
  // was settled against the parent's store and its own came back empty.
  const source = readFileSync(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  const at = source.indexOf("const makeRunShell = (");
  assert.ok(at > 0, "makeRunShell moved");
  const body = source.slice(at, at + 40_000);
  assert.match(body, /getConversationId: \(\) => shellConversationId/);
  assert.match(body, /isSubagentRunner: shellSubagentKind !== undefined/);
  assert.ok(!/getConversationId: \(\) => session\.id/.test(body),
    "the shell still hands out the parent's conversation id");
});
