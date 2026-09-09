// FEEDBACK-1. The agent's reporting tool, its pending store, and the one property the whole design
// rests on: the box writes the report down and posts nothing.
//
// Jason, 2026-09-07: "Titan tried to cover up failure. We need to instill in the agents that failure
// must be reported... 'Would you like to submit this feedback to the developers?'"
//
// Each case here is a way the tool could have gone wrong in a way nobody would have noticed:
//   - the row's OUTLINE NAME. The console keys the chip's plain-words sentence off it, and the row
//     survives only because that name misses the NOT_A_RECEIPT filter. A communicate-wrapped tool
//     would have been named communicateUpdateToolCall and dropped, and there would have been no
//     chip at all -- the failure would have looked exactly like the one this whole item exists to
//     stop, an agent whose reporting nobody can see.
//   - the tool NEVER POSTS. If it ever gained a network call it would need a control-plane
//     credential inside a customer's container, which is the one thing the topology exists to
//     prevent. The dependency surface is asserted, not assumed.
//   - the ACK. A model told "reported" will tell the person the developers have it. They have not:
//     it is sitting in front of the operator. The sentence has to say so.
//   - the STORE CAP and the 0600 mode, because a file that grows without bound on a box nobody
//     opens is a disk-pressure incident with a feedback form on it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".problem-report-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
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

const store = await load("source/host/extensions/feedback/problem-reports.ts", "problem-reports");
const tool = await load("source/host/runner/tools/problem-report-tool.ts", "problem-report-tool");
const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
const contextModule = await load("source/packages/context/core.ts", "context-core");
const ctx = () => contextModule.createContext().withName("problem-report-test");

const freshRoot = () => { const root = mkdtempSync(path.join(tmpdir(), "problem-reports-")); roots.push(root); return root; };

const args = (extra = {}) => ({
  tier: "critical",
  category: "shell",
  title: "The shell refuses every command",
  description: "Every command comes back with 'exec daemon not reachable'.",
  steps: ["Run `ls /workspace`", "Read the answer"],
  tools: [{ name: "Shell", status: "failed", error: "exec daemon not reachable" }],
  ...extra,
});

/**
 * The runner's own contract, in the smallest shape the tool uses: it hands the initial ToolCall to
 * `executeToolCall`, runs the body, and merges the result. Everything the tool emitted is kept so a
 * case can look at what would have landed in the outline.
 */
function handler() {
  const seen = { initial: null, completed: null };
  return {
    seen,
    executeToolCall: async (ctx, initial, id, run, merge) => {
      seen.initial = initial;
      const result = await run(ctx);
      seen.completed = merge(result);
      return result;
    },
  };
}

const runTool = async (built, deps, callArgs) => {
  const stream = (async function* () { yield JSON.stringify(callArgs); })();
  return built.execute(ctx(), handler(), stream, { toolCallId: "call-1" });
};

test("FEEDBACK-1: the row's outline name is one the console can see and label", () => {
  // getOutlineToolCallName returns the proto case verbatim, so this is the name the console reads.
  const call = { tool: { case: tool.PROBLEM_REPORT_OUTLINE_NAME, value: { args: undefined } } };
  assert.equal(outline.getOutlineToolCallName(call), "reportBugToolCall");
  // The filter the console drops non-receipt rows with. A communicate-wrapped tool would have been
  // named communicateUpdateToolCall and thrown away one function before the renderer, which is the
  // exact shape of the bug UX-ERR-1 was: a row the host wrote and the console silently discarded.
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  assert.equal(NOT_A_RECEIPT.test(tool.PROBLEM_REPORT_OUTLINE_NAME), false);
  assert.equal(NOT_A_RECEIPT.test("communicateUpdateToolCall"), true, "which is what the template would have produced");
});

test("FEEDBACK-1: the tool writes the report down and posts nothing", async () => {
  const root = freshRoot();
  const saved = [];
  const built = tool.createProblemReportTool({
    getAgentId: () => "agent-1",
    getAgentName: () => "Titan",
    savePending: (entry) => { saved.push(entry); return store.appendProblemReport(root, entry); },
  });
  const result = await runTool(built, null, args());
  assert.equal(result.result.case, "success");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].agentId, "agent-1");
  assert.equal(saved[0].agentName, "Titan");
  assert.equal(saved[0].report.version, 1);
  assert.equal(saved[0].report.tier, "critical");
  assert.deepEqual(saved[0].report.tools, [{ name: "Shell", status: "failed", error: "exec daemon not reachable" }]);
  const pending = store.readProblemReports(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].report.title, "The shell refuses every command");
});

test("FEEDBACK-1: the sentence the model reads never claims anyone has received it", async () => {
  const root = freshRoot();
  const built = tool.createProblemReportTool({
    getAgentId: () => "agent-1",
    savePending: (entry) => store.appendProblemReport(root, entry),
  });
  const result = await runTool(built, null, args());
  const said = result.result.value.output;
  assert.match(said, /the person/i, "it names who has it now");
  assert.match(said, /Nobody has received it yet/i);
  assert.doesNotMatch(said, /\bsent\b|\bdelivered\b|developers have/i, "nothing here may read as 'it is with the developers'");
  // Critical is the one tier that changes what the agent should say next, and only that.
  assert.match(said, /what is now blocked/i);
  const quieter = await runTool(built, null, args({ tier: "observation" }));
  assert.doesNotMatch(quieter.result.value.output, /what is now blocked/i);
});

test("FEEDBACK-1: a call outside an agent run fails plainly instead of writing an ownerless report", async () => {
  const root = freshRoot();
  const built = tool.createProblemReportTool({
    getAgentId: () => undefined,
    savePending: (entry) => store.appendProblemReport(root, entry),
  });
  const result = await runTool(built, null, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.errorMessage, /outside an agent run/);
  assert.equal(store.readProblemReports(root).length, 0);
});

test("FEEDBACK-1: a store that cannot be written is reported, not swallowed", async () => {
  const built = tool.createProblemReportTool({
    getAgentId: () => "agent-1",
    savePending: () => { throw new Error("read-only file system"); },
  });
  const result = await runTool(built, null, args());
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.errorMessage, /could not be written down: read-only file system/);
});

test("FEEDBACK-1: nothing in the tool or its store can reach a network", async () => {
  // The whole security argument in one assertion. A network call here would need a control-plane
  // credential inside a customer's container, and both cp doors are fatal there: CP_RELAY_TOKEN
  // reads every tenant's gateway token, CP_ADMIN_TOKEN deletes services. So the box writes a file
  // and the console -- already signed in as the tenant -- is the only thing that sends.
  const { readFile } = await import("node:fs/promises");
  for (const file of ["source/host/runner/tools/problem-report-tool.ts", "source/host/extensions/feedback/problem-reports.ts"]) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /require\(["']node:https?["']\)/, /from "node:https?"/, /\bundici\b/]) {
      assert.doesNotMatch(code, forbidden, `${file} must not be able to send anything anywhere`);
    }
  }
});

test("FEEDBACK-1: the payload is v1 whichever of the three carriers minted it", () => {
  const payload = tool.buildProblemReportPayload(args({ steps: ["  ", "one"] }), { now: () => 0 });
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.steps, ["one"], "an empty step is not a step");
  assert.equal(payload.at, "1970-01-01T00:00:00.000Z");
  // No workspace field anywhere: the relay stamps it from its own registry, so a box can neither
  // name its own tenant nor anyone else's.
  assert.equal("workspace" in payload, false);
});

test("FEEDBACK-1: the pending file is 0600 and drops the oldest past fifty", () => {
  const root = freshRoot();
  for (let i = 0; i < store.PROBLEM_REPORT_STORE_CAP + 5; i += 1) {
    store.appendProblemReport(root, {
      agentId: "agent-1",
      report: tool.buildProblemReportPayload(args({ title: `fault ${i}` })),
    }, { id: `pr-${i}` });
  }
  const kept = store.readProblemReports(root);
  assert.equal(kept.length, store.PROBLEM_REPORT_STORE_CAP);
  assert.equal(kept[0].report.title, "fault 5", "the five oldest went");
  assert.equal(kept.at(-1).report.title, `fault ${store.PROBLEM_REPORT_STORE_CAP + 4}`);
  assert.equal(statSync(store.problemReportsPath(root)).mode & 0o777, 0o600);
});

test("FEEDBACK-1: resolving one clears it, and a missing file is silence rather than an error", () => {
  const root = freshRoot();
  assert.deepEqual(store.readProblemReports(root), [], "no file is 'nothing pending'");
  const one = store.appendProblemReport(root, { agentId: "a", report: tool.buildProblemReportPayload(args()) });
  const two = store.appendProblemReport(root, { agentId: "a", report: tool.buildProblemReportPayload(args({ title: "second" })) });
  assert.equal(store.resolveProblemReport(root, one.id), true);
  assert.equal(store.resolveProblemReport(root, one.id), false, "twice is not an error, it is already gone");
  assert.deepEqual(store.readProblemReports(root).map((r) => r.id), [two.id]);
});

test("FEEDBACK-1: a corrupt store is nothing pending rather than a box that will not answer", () => {
  const root = freshRoot();
  writeFileSync(store.problemReportsPath(root), "{ not json");
  assert.deepEqual(store.readProblemReports(root), []);
  writeFileSync(store.problemReportsPath(root), JSON.stringify({ version: 1, reports: [{ id: "x" }, null, 7] }));
  assert.deepEqual(store.readProblemReports(root), [], "a row with no report is not a report");
});
