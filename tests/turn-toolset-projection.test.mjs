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
