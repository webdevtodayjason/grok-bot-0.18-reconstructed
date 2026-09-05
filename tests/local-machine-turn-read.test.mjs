// One local-machine answer per turn, and a pin that cannot invent a daemon.
//
// TOOLS-18. TOOLS-15 made five tools (ExternalShell, ExternalRead, AwaitExternalShell, CopyToBox,
// CopyFromBox) and the prompt paragraphs that teach them swing on one fact: is a computer answering
// on the local-exec bridge. But the toolset builder and the system-prompt assembly each asked the
// bridge for themselves, and that answer is a 30 s liveness window -- so a heartbeat that lapsed
// between the two reads sent a turn whose prompt taught five tools the wire had already withheld
// (or the reverse). And `SAND_LOCAL_MACHINE=1` was read before the bridge was asked at all, so it
// pinned the connected world on a box with no daemon: five tools that block until the response
// watchdog gives up, which is the exact failure TOOLS-15 exists to stop.
//
// These cases drive the two real consumers -- `buildTurnTools` and the prompt glue's box section --
// off one `createTurnLocalMachineReader`, with a bridge that flips its answer on every call. On the
// old behaviour the two disagree within a single turn and the pin offers the five with nothing on
// the far end.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Staged inside node_modules, as the other toolset suites do: the bundle keeps CommonJS
// dependencies that require() at load time and resolve against the staged file's directory.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".local-machine-turn-read-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
};
const setting = await bundle("source/host/sand-box-setting.ts", "sand-box-setting.cjs");
const toolset = await bundle("source/host/runner/tools/turn-toolset.ts", "turn-toolset.cjs");
const glue = await bundle("source/host/runner/prompt-collector-glue.ts", "prompt-collector-glue.cjs");

const tool = (name) => ({ name, toolIdentifier: name, execute: async () => ({}) });
const HOST_MACHINE_TOOLS = ["ExternalShell", "ExternalRead", "AwaitExternalShell", "CopyToBox", "CopyFromBox"];
// The marker the host reports as the `localMachine` prompt section: the paragraph that teaches the
// two machines and the CopyToBox / CopyFromBox pair between them.
const TWO_MACHINES = "Your box and the user's computer are separate machines";

const turn = { autoReviewModes: { hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" } };
const props = { mcp: { mcpMeta: { getMcpTools: () => [], callOptions: {} } } };
const hostFor = (overrides) => ({
  isSubagentRunner: false,
  isSharedRoomRunner: false,
  isBoxScopedSubagent: false,
  isComputerUseSubagent: false,
  isBrowserUseSubagent: false,
  isSystemPromptOverridden: false,
  remoteBoxHasDesktop: true,
  getConversationId: () => "agent-under-test",
  getRemoteBoxAvailable: () => true,
  cloudAgentsDisabledByTeam: () => false,
  spotlightEnabled: () => false,
  factories: {
    sendMessage: () => tool("SendMessage"),
    externalShell: () => tool("ExternalShell"),
    externalRead: () => tool("ExternalRead"),
    externalAwait: () => tool("AwaitExternalShell"),
    fileTransfer: () => [tool("CopyToBox"), tool("CopyFromBox")],
    webSearch: () => tool("WebSearch"),
    boxShell: () => tool("Shell"),
    boxRead: () => tool("Read"),
    boxAwait: () => tool("AwaitShell"),
    mcpMeta: () => [tool("GetMcpTools"), tool("CallMcpTool")],
  },
  ...overrides,
});

// What the two halves of a turn actually say about the user's computer, each asked through the
// reader exactly as the composition wires them.
const turnHalves = (reader) => {
  const names = toolset
    .buildTurnTools(hostFor({ localMachineConnected: () => reader.read().connected }), turn, props)
    .getAllTools().map((entry) => entry.name);
  const section = glue.createPromptCollectorGlue({
    isLocalMachineConnected: () => reader.read().connected,
  }).getRemoteBoxSection();
  return {
    toolsOffered: HOST_MACHINE_TOOLS.every((name) => names.includes(name)),
    toolsWithheld: HOST_MACHINE_TOOLS.every((name) => !names.includes(name)),
    promptTeaches: section.includes(TWO_MACHINES),
  };
};

// A bridge whose 30 s liveness window lapses between one read and the next: exactly the race the
// two reads used to lose. It also counts, so "one read" is asserted as a number and not inferred
// from the answers agreeing by luck.
const flappingBridge = () => {
  let calls = 0;
  const answer = () => { calls += 1; return calls % 2 === 1; };
  answer.calls = () => calls;
  return answer;
};

test("the toolset and the prompt see one answer per turn, so a lapsed heartbeat cannot split a turn", () => {
  const bridge = flappingBridge();
  const reader = setting.createTurnLocalMachineReader({
    readOverride: () => undefined,
    hasAnnouncedComputer: bridge,
  });
  const first = turnHalves(reader);
  assert.equal(bridge.calls(), 1, "the bridge is asked once for the turn, not once per consumer");
  assert.equal(first.toolsOffered, true, "the first read found a computer, so the five are offered");
  assert.equal(first.promptTeaches, true, "and the prompt that goes with them teaches the two machines");

  // The turn boundary, and only the turn boundary, re-reads: a computer that drops out (or
  // connects) mid-conversation still moves the toolset and the prompt together on the next turn.
  reader.beginTurn();
  const second = turnHalves(reader);
  assert.equal(bridge.calls(), 2, "the next turn asks the bridge again");
  assert.equal(second.toolsWithheld, true, "the bridge went quiet, so the five are withheld");
  assert.equal(second.promptTeaches, false, "and the two-machines paragraph goes with them");
});

test("the pin cannot offer the five with no daemon answering", () => {
  // The unit the host resolves through. "1" used to short-circuit before the bridge was asked.
  assert.equal(setting.resolveLocalMachineOffered("1", () => false), false,
    "SAND_LOCAL_MACHINE=1 with nothing on the bridge does not offer the five");
  assert.equal(setting.resolveLocalMachineOffered("1", () => true), true,
    "with a daemon answering the pin is honoured");

  const reader = setting.createTurnLocalMachineReader({
    readOverride: () => "1",
    hasAnnouncedComputer: () => false,
  });
  const answer = reader.read();
  assert.equal(answer.connected, false);
  assert.equal(answer.source, "setting", "the trace still says a pin was in force, so a gate can prove it landed");
  const halves = turnHalves(reader);
  assert.equal(halves.toolsWithheld, true, "the pinned turn hands the model no tool the bridge cannot carry");
  assert.equal(halves.promptTeaches, false, "and teaches none of them either");
});

test("the pin still withholds while a daemon answers, and unset is the bridge alone", () => {
  const pinnedOff = setting.createTurnLocalMachineReader({
    readOverride: () => "0",
    hasAnnouncedComputer: () => true,
  }).read();
  assert.equal(pinnedOff.connected, false, "the withhold pin is the leg a gate can still drive");
  assert.equal(pinnedOff.source, "setting");

  const unset = setting.createTurnLocalMachineReader({
    readOverride: () => undefined,
    hasAnnouncedComputer: () => true,
  }).read();
  assert.equal(unset.connected, true);
  assert.equal(unset.source, "bridge");
});
