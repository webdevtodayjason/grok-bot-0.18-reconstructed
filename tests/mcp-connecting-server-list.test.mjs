import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-connecting-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const READY = "readyfiles";
const STALLED = "stalledconnector";

const displayRow = (id, serverIdentifier) => ({
  id,
  name: serverIdentifier,
  serverIdentifier,
  config: { command: "node", args: [`${serverIdentifier}.mjs`] },
  isTeamServer: false,
  disabledByTeamAdminPolicy: false,
});

// CONNECT-2. The transport here is the whole point: a connector waiting on its sign-in never
// answers, and the box lists every stdio server in ONE call, so one such connector used to hold
// the list open for the box's whole connection timeout -- and the console boots on that list.
test("a connector whose connect never resolves does not hold listServers open", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-manager.ts");
  // The stalled read is released only in the finally below, so nothing in this test ever waits on
  // it; letting it settle at the end is what keeps a dangling promise out of the runner.
  const stalledReleases = [];
  try {
    let rows = [displayRow("1", READY), displayRow("2", STALLED)];
    const calls = [];
    const manager = new loaded.module.SandMcpManager({
      includeBuiltins: false,
      accountServersProvider: async () => ({ servers: rows, cacheScope: "test" }),
      effectivePluginsProvider: async () => [],
      backendMcpExec: { listServers: async () => [], listTools: async () => [] },
      getMachineId: async () => "test-machine",
    });
    manager.setBoxRuntime({
      isBoxExecWired: () => true,
      getToolsRaw: async () => [],
      listBoxServers: (identifiers, options) => {
        calls.push({ identifiers: [...identifiers], options });
        // The stalled connector is in this batch, so the box has nothing to say yet and never will.
        if (identifiers.includes(STALLED))
          return new Promise((resolve) => stalledReleases.push(resolve));
        return Promise.resolve(
          identifiers.map((serverIdentifier) => ({
            serverIdentifier,
            status: "connected",
            toolCount: 1,
            tools: [{ toolName: "read_text_file" }],
          })),
        );
      },
      invalidateToolsCache: () => {},
      resetPushState: () => {},
    });

    const started = Date.now();
    const first = await manager.listServers();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `listServers waited ${elapsed} ms on a connect that never resolves`);

    assert.equal(calls.length, 1, "listServers did not start a box read");
    assert.equal(calls[0].options?.kickOnly, true, "the box read must not sit on a connect");

    const stalled = first.servers.find((server) => server.serverIdentifier === STALLED);
    assert.ok(stalled != null, "the stalled connector is missing from the list");
    assert.equal(stalled.status, "initializing", `the stalled connector reports ${stalled.status}`);
    assert.equal(stalled.toolCount, 0);
    assert.equal(stalled.statusDetail, undefined, "a connecting server is not an error");

    // Removing it and refreshing is the operator's whole recovery, and it used to need a box
    // restart because the pending connect was still being waited on and the server still loaded.
    rows = [displayRow("1", READY)];
    const removedAt = Date.now();
    const after = await manager.reloadServers();
    const removalElapsed = Date.now() - removedAt;
    assert.ok(removalElapsed < 1000, `the refresh waited ${removalElapsed} ms on the abandoned connect`);
    assert.equal(
      after.servers.find((server) => server.serverIdentifier === STALLED),
      undefined,
      "the removed connector survived the refresh",
    );

    // The read that ran after the refresh answered, which it could only do because the manager
    // let go of the one still in flight.
    const ready = after.servers.find((server) => server.serverIdentifier === READY);
    assert.equal(ready.status, "connected");
    assert.equal(ready.toolCount, 1);
    assert.deepEqual(calls.at(-1).identifiers, [READY]);
  } finally {
    for (const release of stalledReleases) release([]);
    await new Promise((resolve) => setImmediate(resolve));
    await loaded.dispose();
  }
});

// CONNECT-2. The placeholder is a promise, not a verdict: "loading" is what the manager itself
// writes down for a server nobody has heard back from, so remembering it as a known state would
// skip the wait forever and leave the list serving that placeholder for the life of the page.
test("a server that finishes connecting replaces the placeholder on the next list", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-manager.ts");
  try {
    const answers = [
      [{ serverIdentifier: READY, status: "loading", toolCount: 0, tools: [] }],
      [
        {
          serverIdentifier: READY,
          status: "error",
          statusDetail: "spawn node ENOENT",
          toolCount: 0,
          tools: [],
        },
      ],
    ];
    const manager = new loaded.module.SandMcpManager({
      includeBuiltins: false,
      accountServersProvider: async () => ({
        servers: [displayRow("1", READY)],
        cacheScope: "test",
      }),
      effectivePluginsProvider: async () => [],
      backendMcpExec: { listServers: async () => [], listTools: async () => [] },
      getMachineId: async () => "test-machine",
    });
    manager.setBoxRuntime({
      isBoxExecWired: () => true,
      getToolsRaw: async () => [],
      // A real tick before answering, so a list that does not wait genuinely misses this answer.
      listBoxServers: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return answers.shift() ?? [];
      },
      invalidateToolsCache: () => {},
      resetPushState: () => {},
    });

    const first = await manager.listServers();
    assert.equal(first.servers[0].status, "initializing");

    // Without the wait this second call answers "initializing" again, forever: the box has moved
    // on and nothing else re-lists.
    const second = await manager.listServers();
    assert.equal(second.servers[0].status, "error", "the settled answer never landed");
    assert.equal(second.servers[0].statusDetail, "spawn node ENOENT");
  } finally {
    await loaded.dispose();
  }
});

// CONNECT-2. Answering from the last known state must not outlive the box that reported it: a
// server last seen connected says nothing about a box that has stopped answering.
test("a box that stops answering is reported unreachable, not last connected", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-manager.ts");
  try {
    let reachable = true;
    const manager = new loaded.module.SandMcpManager({
      includeBuiltins: false,
      accountServersProvider: async () => ({
        servers: [displayRow("1", READY)],
        cacheScope: "test",
      }),
      effectivePluginsProvider: async () => [],
      backendMcpExec: { listServers: async () => [], listTools: async () => [] },
      getMachineId: async () => "test-machine",
    });
    manager.setBoxRuntime({
      isBoxExecWired: () => true,
      getToolsRaw: async () => [],
      listBoxServers: async (identifiers) => {
        if (!reachable) throw new Error("box exec is gone");
        return identifiers.map((serverIdentifier) => ({
          serverIdentifier,
          status: "connected",
          toolCount: 1,
          tools: [{ toolName: "read_text_file" }],
        }));
      },
      invalidateToolsCache: () => {},
      resetPushState: () => {},
    });

    const first = await manager.listServers();
    assert.equal(first.servers[0].status, "connected");
    assert.equal(first.servers[0].toolCount, 1);

    // The read this list kicks off is the one that discovers the box is gone.
    reachable = false;
    await manager.listServers();
    await new Promise((resolve) => setImmediate(resolve));

    const third = await manager.listServers();
    assert.equal(third.servers[0].status, "error", "a dead box kept reporting connected");
    assert.equal(third.servers[0].statusDetail, "Grok Bot's computer unreachable");
    assert.equal(third.servers[0].toolCount, 0);
  } finally {
    await loaded.dispose();
  }
});
