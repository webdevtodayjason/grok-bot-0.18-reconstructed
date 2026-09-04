// Wave A, the two gates that decided what the model could reach.
//
// TOOLS-01: `buildTurnTools` offers GetMcpTools / CallMcpTool only when the turn carries a live
// MCP projection on its props. The reconstruction never put one there on the production path, so
// the pair was withheld from every agent even with a connector running -- and because a supplied
// factory alone must stay dormant, "the factory exists" is not the thing to assert. These cases
// pin both halves: projection present, pair offered; factory present but no projection, withheld.
//
// TOOLS-02: a box-scoped subagent (computerUse / browserUse) is offered its three box tools and
// nothing from the user's machine, the web, or the connector plane. It used to get twelve.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// CJS, and loaded from a file rather than a data: URL. The tree pulls in CommonJS dependencies
// that call require() at load time (mime-types), which an ESM bundle cannot satisfy; and the
// bundle is ~12MB, which node prints in full as the module specifier of any stack frame.
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/tools/turn-toolset.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  // jsonc-parser ships a UMD build whose require() calls are relative and unresolvable once
  // inlined; left external it is required from the repo's own node_modules.
  external: ["jsonc-parser"],
  // The tree has import.meta uses on branches this test never reaches; the cjs warning for each
  // would drown the suite output.
  logLevel: "silent",
});
// Staged inside node_modules (gitignored, and removed below) rather than the OS temp dir: the
// bundle keeps a handful of UMD/CJS dependencies that require() at load time, and those resolve
// against the staged file's directory, which under /tmp has no node_modules above it.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".turn-toolset-test-"));
const bundlePath = path.join(stage, "turn-toolset.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
after(() => rmSync(stage, { recursive: true, force: true }));
const mod = createRequire(import.meta.url)(bundlePath);

const tool = (name) => ({ name, toolIdentifier: name, execute: async () => ({}) });

const hostFor = (overrides = {}) => ({
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
    webSearch: () => tool("WebSearch"),
    cloudAgent: () => tool("CloudAgent"),
    boxShell: () => tool("Shell"),
    boxRead: () => tool("Read"),
    boxAwait: () => tool("AwaitShell"),
    computer: () => tool("Computer"),
    browser: () => [tool("browser_navigate"), tool("browser_snapshot")],
    mcpMeta: () => [tool("GetMcpTools"), tool("CallMcpTool")],
    mcpManagement: () => [tool("SetMcpInstructions")],
  },
  ...overrides,
});

const turn = { autoReviewModes: { hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" } };
// The live projection the host binds per turn; only its presence is read by the gate.
const propsWithMcp = { mcp: { mcpMeta: { getMcpTools: () => [], callOptions: {} } } };

const namesOf = (handle) => handle.getAllTools().map((entry) => entry.name);

test("the MCP meta pair is offered when the turn carries a live MCP projection", () => {
  const names = namesOf(mod.buildTurnTools(hostFor(), turn, propsWithMcp));
  assert.ok(names.includes("GetMcpTools"), `GetMcpTools offered (got ${names.join(", ")})`);
  assert.ok(names.includes("CallMcpTool"), `CallMcpTool offered (got ${names.join(", ")})`);
});

test("a supplied mcpMeta factory alone does not offer the pair", () => {
  const names = namesOf(mod.buildTurnTools(hostFor(), turn, {}));
  assert.ok(!names.includes("GetMcpTools"));
  assert.ok(!names.includes("CallMcpTool"));
  // The management tools are a different lane and must stay offered either way.
  assert.ok(names.includes("SetMcpInstructions"));
});

test("a box-scoped computerUse subagent gets Shell, Read and Computer and nothing else", () => {
  const names = namesOf(mod.buildTurnTools(
    hostFor({
      isSubagentRunner: true,
      isBoxScopedSubagent: true,
      isComputerUseSubagent: true,
    }),
    { ...turn, subagentConfigs: [] },
    propsWithMcp,
  ));
  assert.deepEqual(names, ["Shell", "Read", "Computer"]);
});

test("a box-scoped browserUse subagent gets its browser tools, not the chief's", () => {
  const names = namesOf(mod.buildTurnTools(
    hostFor({
      isSubagentRunner: true,
      isBoxScopedSubagent: true,
      isBrowserUseSubagent: true,
    }),
    { ...turn, subagentConfigs: [] },
    propsWithMcp,
  ));
  assert.deepEqual(names, ["Shell", "Read", "browser_navigate", "browser_snapshot"]);
});

// TOOLS-15: the five tools bound with surface "host_machine" reach the operator's own computer
// over the local-exec bridge. Offered while a computer answers there; withheld, and named as
// withheld with its reason, when none does. Before this the model was handed all five on a
// deployment where nothing ever registered on that bridge, so every call blocked until it timed
// out.
const HOST_MACHINE_FACTORIES = {
  externalRead: () => tool("ExternalRead"),
  externalAwait: () => tool("AwaitExternalShell"),
  fileTransfer: () => [tool("CopyToBox"), tool("CopyFromBox")],
};
const HOST_MACHINE_TOOLS = ["ExternalShell", "ExternalRead", "AwaitExternalShell", "CopyToBox", "CopyFromBox"];

const hostWithComputer = (connected) => hostFor({
  ...(connected === undefined ? {} : { localMachineConnected: () => connected }),
  factories: { ...hostFor().factories, ...HOST_MACHINE_FACTORIES },
});

test("the five host-machine tools are offered while a computer is connected", () => {
  const names = namesOf(mod.buildTurnTools(hostWithComputer(true), turn, propsWithMcp));
  for (const name of HOST_MACHINE_TOOLS) assert.ok(names.includes(name), `${name} offered (got ${names.join(", ")})`);
});

test("a host that never answers the question keeps them, so nothing else changes shape", () => {
  const names = namesOf(mod.buildTurnTools(hostWithComputer(undefined), turn, propsWithMcp));
  for (const name of HOST_MACHINE_TOOLS) assert.ok(names.includes(name), `${name} offered (got ${names.join(", ")})`);
});

test("with no computer connected the five are withheld and the rest of the toolset stands", () => {
  const names = namesOf(mod.buildTurnTools(hostWithComputer(false), turn, propsWithMcp));
  for (const name of HOST_MACHINE_TOOLS) assert.ok(!names.includes(name), `${name} withheld (got ${names.join(", ")})`);
  // The box surface and the web are a different lane and must survive the withhold untouched.
  for (const name of ["Shell", "Read", "AwaitShell", "WebSearch", "GetMcpTools"]) {
    assert.ok(names.includes(name), `${name} still offered (got ${names.join(", ")})`);
  }
});

test("the trace line names each withheld tool with its reason", () => {
  const previous = process.env.SAND_TOOL_TRACE;
  process.env.SAND_TOOL_TRACE = "1";
  const info = console.info;
  const lines = [];
  console.info = (line) => lines.push(String(line));
  try {
    mod.buildTurnTools(hostWithComputer(false), turn, propsWithMcp);
  } finally {
    console.info = info;
    if (previous === undefined) delete process.env.SAND_TOOL_TRACE;
    else process.env.SAND_TOOL_TRACE = previous;
  }
  const traced = lines.find((line) => line.includes("[sand][toolset] "));
  assert.ok(traced != null, `a toolset trace line was written (got ${lines.length} lines)`);
  const parsed = JSON.parse(traced.slice(traced.indexOf("[sand][toolset] ") + "[sand][toolset] ".length));
  assert.deepEqual(
    parsed.withheld.filter((entry) => entry.reason === "no_local_machine").map((entry) => entry.tool),
    HOST_MACHINE_TOOLS,
  );
  // Where the answer came from, so an operator reading the log can tell a quiet bridge from a
  // pinned SAND_LOCAL_MACHINE, and the gate can prove its pin reached the host.
  assert.equal(parsed.localMachineSource, "bridge");
});

test("the trace line says when the answer was pinned rather than read off the bridge", () => {
  const previous = process.env.SAND_TOOL_TRACE;
  process.env.SAND_TOOL_TRACE = "1";
  const info = console.info;
  const lines = [];
  console.info = (line) => lines.push(String(line));
  try {
    mod.buildTurnTools(hostFor({
      localMachineConnected: () => false,
      localMachineSource: () => "setting",
      factories: { ...hostFor().factories, ...HOST_MACHINE_FACTORIES },
    }), turn, propsWithMcp);
  } finally {
    console.info = info;
    if (previous === undefined) delete process.env.SAND_TOOL_TRACE;
    else process.env.SAND_TOOL_TRACE = previous;
  }
  const traced = lines.find((line) => line.includes("[sand][toolset] "));
  const parsed = JSON.parse(traced.slice(traced.indexOf("[sand][toolset] ") + "[sand][toolset] ".length));
  assert.equal(parsed.localMachineSource, "setting");
  assert.equal(parsed.localMachineConnected, false);
});

// TOOLS-17: the shared-room filter, both halves. A member answering in a cross-user room is cut
// down to the room set -- SendMessage plus the box surface as private scratch -- and with the box
// tools switched off to SendMessage alone, because that is the only thing a room delivers. Neither
// half had ever run: the shared-room runner does not appear in any traced toolset on this
// deployment, so until scripts/verify-toolset.mjs --room the filter was unexercised code.
const ROOM_FACTORIES = { screenshot: () => tool("Screenshot") };
const roomHost = (boxTools) => hostFor({
  isSharedRoomRunner: true,
  ...(boxTools === undefined ? {} : { isSharedRoomBoxToolsEnabled: () => boxTools }),
  factories: { ...hostFor().factories, ...ROOM_FACTORIES },
});

test("a shared-room member is cut down to the room set", () => {
  const names = namesOf(mod.buildTurnTools(roomHost(true), turn, propsWithMcp));
  assert.deepEqual(names, ["SendMessage", "Shell", "Read", "AwaitShell", "Screenshot"]);
});

test("a host that never answers the box-tools question keeps the room set", () => {
  const names = namesOf(mod.buildTurnTools(roomHost(undefined), turn, propsWithMcp));
  assert.deepEqual(names, ["SendMessage", "Shell", "Read", "AwaitShell", "Screenshot"]);
});

test("with the box tools switched off the room is text only", () => {
  const names = namesOf(mod.buildTurnTools(roomHost(false), turn, propsWithMcp));
  assert.deepEqual(names, ["SendMessage"]);
});

test("the trace line says which room filter ran, and says nothing outside a room", () => {
  const previous = process.env.SAND_TOOL_TRACE;
  process.env.SAND_TOOL_TRACE = "1";
  const info = console.info;
  const lines = [];
  console.info = (line) => lines.push(String(line));
  try {
    mod.buildTurnTools(roomHost(false), turn, propsWithMcp);
    mod.buildTurnTools(hostFor(), turn, propsWithMcp);
  } finally {
    console.info = info;
    if (previous === undefined) delete process.env.SAND_TOOL_TRACE;
    else process.env.SAND_TOOL_TRACE = previous;
  }
  const parsed = lines
    .filter((line) => line.includes("[sand][toolset] "))
    .map((line) => JSON.parse(line.slice(line.indexOf("[sand][toolset] ") + "[sand][toolset] ".length)));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].isSharedRoomRunner, true);
  assert.equal(parsed[0].sharedRoomBoxTools, false);
  assert.equal(parsed[1].isSharedRoomRunner, false);
  assert.equal(parsed[1].sharedRoomBoxTools, null);
});
