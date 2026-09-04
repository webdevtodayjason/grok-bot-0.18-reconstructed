// A deleted agent leaves no system-prompt report behind.
//
// REPORTS-1. dumpAssembledSystemPrompt writes sand-system-prompt-<id>.json beside the sand data
// whenever SAND_TOOL_TRACE is on, and runDeleteAgents unlinked it -- but only in the loop that
// deletes the non-active agents. Deleting the ACTIVE agent takes a separate branch further down,
// and that branch never unlinked. Creating an agent makes it the active one, so every probe agent
// created and deleted in one breath took the branch with no unlink: six of the seven reports on
// the box belonged to ids whose agent directory was already gone. These cases delete on each
// branch and assert the file is gone either way.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "sand-delete-report-"));
// Pinned per case: tests/index.js loads every suite into one process, so another suite pointing
// SAND_DATA_ROOT at its own temp root would decide where these cases look for the report.
const useRoot = () => { process.env.SAND_DATA_ROOT = root; };
useRoot();
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/agent-lifecycle.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".sand-delete-report-test-"));
after(() => {
  delete process.env.SAND_DATA_ROOT;
  rmSync(root, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
});
const bundlePath = path.join(stage, "agent-lifecycle.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const { AgentLifecycle } = createRequire(import.meta.url)(bundlePath);

const reportPath = (id) => path.join(root, `sand-system-prompt-${id}.json`);
const writeReport = (id) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(reportPath(id), JSON.stringify({ agentId: id, length: 1, sections: {} }));
};

// Only the members runDeleteAgents actually reaches. A session is { id, agentStore }; the store
// answers whatever the branch asks of it and nothing more.
function fakeManager(activeId, otherIds = []) {
  const session = (id) => ({ id, agentStore: { dispose: async () => {} } });
  const live = new Map([activeId, ...otherIds].map((id) => [id, session(id)]));
  return {
    sessions: {
      loaded: true,
      activeSession: session(activeId),
      deletedAgentIds: new Set(),
      liveSessions: live,
      pendingSessionOpens: new Map(),
      tryEnsureSession: async () => session(activeId),
      openSessionOnce: async (id) => session(id),
      invalidateDeferredActivation() {},
      setActiveSession() {},
      setActiveTranscript() {},
      clearActiveTranscript() {},
    },
    ackObligations: { markAckObligationLost() {}, ackRunTokens: new Map() },
    backgroundWakes: {
      pendingSubagentCompletions: new Map(), pendingShellCompletions: new Map(),
      pendingInbound: new Map(), pendingAgentInbound: new Map(),
      pendingChannelFailures: new Map(), dmPreemptedWakeAgentIds: new Set(),
    },
    groupChat: { dmPreemptedGroupMemberIds: new Set() },
    runnerRegistry: { runners: new Map(), activeGroupMemberRunners: new Map() },
    runLifecycle: {
      runningAgentIds: () => new Set(),
      drainExclusiveRuns: async () => {},
      closeSessionWhenIdle() {},
      watchActiveSession() {},
    },
    roster: {
      forgetAgentSubagentWork() {}, lastRunnerAsyncTasks: new Map(),
      emitAsyncTasksForAgent() {}, emit() {}, emitAgents: async () => {},
    },
    trayErrors: { clearForAgent() {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: { clear() {} } },
    telemetry: { reportTurnInterrupt() {} },
    sessionStore: {
      deleteSession: async () => {},
      markSessionViewed: async () => {},
      getTranscriptEntries: async () => [],
      listAgents: async () => otherIds.map((id) => ({ id })),
      listAgentRecordIds: async () => otherIds,
      createFallbackSession: async (open) => open("fallback-agent"),
    },
    unwatchActiveSession() {},
  };
}

test("deleting the ACTIVE agent removes its prompt report", async () => {
  useRoot();
  const id = "3882b623-02f3-40c0-b369-250b09162968";
  const survivor = "4ef9b708-d531-4a17-b711-711862d4d9a3";
  writeReport(id);
  assert.equal(existsSync(reportPath(id)), true);
  await new AgentLifecycle(fakeManager(id, [survivor])).runDeleteAgents(new Set([id]));
  assert.equal(existsSync(reportPath(id)), false);
});

test("deleting a non-active agent removes its prompt report too", async () => {
  useRoot();
  const active = "4ef9b708-d531-4a17-b711-711862d4d9a3";
  const other = "5cbb25f9-6a6f-44a9-8a6e-82c35fd984cb";
  writeReport(other);
  await new AgentLifecycle(fakeManager(active, [other])).runDeleteAgents(new Set([other]));
  assert.equal(existsSync(reportPath(other)), false);
});

test("a report belonging to an agent nobody deleted is left alone", async () => {
  useRoot();
  const active = "9508a4ae-fb50-49f4-8ba3-45356e6f1374";
  const bystander = "c161aaf0-3485-4822-869d-af42f7f1ebac";
  writeReport(active);
  writeReport(bystander);
  await new AgentLifecycle(fakeManager(active, [bystander])).runDeleteAgents(new Set([active]));
  assert.equal(existsSync(reportPath(bystander)), true);
});
