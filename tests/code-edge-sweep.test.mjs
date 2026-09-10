// The sweep, which is the only thing that actually enforces a coding task's wall clock (CODE-1).
//
// A timer in the relay's memory does not survive a restart, and the relay is restarted as the LAST
// step of every ship. So the deadline lives on the container's own label and a relay that has never
// heard of a task can still end it. That one fact is what every case here is about.
//
// The other half is what the sweep must NOT touch. It lists BY LABEL ONLY and never by name shape: the
// local Mac's box carries no role label at all, a reader's own probe containers share this wave's name
// prefix, and titanbot-net and the proxy's own Coolify network are somebody else's.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_NAME_PREFIX, CODE_ROLE, SHARED_NETWORK, createCodeEdge, sweepDecisions,
} from "../ui/code-edge.mjs";

const NOW = 1_760_000_000_000;
const ours = (taskId, over = {}) => ({
  id: `id-${taskId}`,
  name: `${CODE_NAME_PREFIX}${taskId}`,
  labels: {
    "com.titanbot.role": CODE_ROLE,
    "com.titanbot.tenant": "demo",
    "com.titanbot.task": taskId,
    "com.titanbot.agent": "a_titan",
    "com.titanbot.deadline": String(NOW + 60_000),
    ...over,
  },
});

// ---- the decisions, with nothing running ---------------------------------------------------------

test("a container past its own deadline label goes, and a live one inside it stays", () => {
  const decided = sweepDecisions({
    containers: [
      ours("aaaaaaaaaaaa", { "com.titanbot.deadline": String(NOW - 1) }),
      ours("bbbbbbbbbbbb", { "com.titanbot.deadline": String(NOW + 600_000) }),
    ],
    live: new Set(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
    nowMs: NOW,
  });
  assert.deepEqual(decided.remove.map((c) => c.taskId), ["aaaaaaaaaaaa"]);
  assert.equal(decided.remove[0].reason, "timed_out");
  assert.deepEqual(decided.keep.map((c) => c.name), [`${CODE_NAME_PREFIX}bbbbbbbbbbbb`]);
});

test("a container this relay has never heard of is an orphan, which is the restart case", () => {
  // The whole reason the task id is on the label: after a restart the relay's own memory is empty, so
  // anything labelled ours and not in it is a container whose bot is waiting on a row nobody will close.
  const decided = sweepDecisions({ containers: [ours("cccccccccccc")], live: new Set(), nowMs: NOW });
  assert.equal(decided.remove.length, 1);
  assert.equal(decided.remove[0].reason, "orphan");
  assert.equal(decided.remove[0].slug, "demo", "the tenant comes off the label, so the claim can be closed");
  assert.equal(decided.remove[0].agentId, "a_titan");
});

test("a container with our name and not our label is somebody else's and is never touched", () => {
  // The codeprobe-* and tbcode-gate-* containers a reader or a gate stood up are exactly this shape.
  const decided = sweepDecisions({
    containers: [
      { id: "x", name: "tbcode-gate-probe", labels: {} },
      { id: "y", name: "tbcode-aaaaaaaaaaaa", labels: { "com.titanbot.role": "box" } },
      { id: "z", name: "grok-bot-local-vm", labels: {} },
    ],
    live: new Set(),
    nowMs: NOW,
  });
  assert.deepEqual(decided.remove, [], "name shape is not ownership");
});

test("a deadline that is missing or unreadable does not make a live task expire", () => {
  for (const deadline of ["", "soon", "0", "NaN"]) {
    const decided = sweepDecisions({
      containers: [ours("dddddddddddd", { "com.titanbot.deadline": deadline })],
      live: new Set(["dddddddddddd"]),
      nowMs: NOW,
    });
    assert.deepEqual(decided.remove, [], `a ${JSON.stringify(deadline)} deadline must not kill a running task`);
  }
});

test("a task network with nothing of ours in it goes, and the shared network never does", () => {
  const decided = sweepDecisions({
    containers: [],
    networks: [
      { id: "n1", name: "tbcode-aaaaaaaaaaaa", labels: { "com.titanbot.role": CODE_ROLE, "com.titanbot.task": "aaaaaaaaaaaa" }, members: ["titanbot-proxy-abc"] },
      { id: "n2", name: "tbcode-bbbbbbbbbbbb", labels: { "com.titanbot.role": CODE_ROLE, "com.titanbot.task": "bbbbbbbbbbbb" }, members: ["titanbot-proxy-abc", "tbcode-bbbbbbbbbbbb"] },
      { id: "n3", name: SHARED_NETWORK, labels: { "com.titanbot.role": CODE_ROLE }, members: ["titanbot-box-demo"] },
      { id: "n4", name: "coolify", labels: {}, members: ["titanbot-proxy-abc"] },
    ],
    live: new Set(["bbbbbbbbbbbb"]),
    nowMs: NOW,
  });
  const names = decided.removeNetworks.map((n) => n.name);
  assert.ok(names.includes("tbcode-aaaaaaaaaaaa"), "the proxy alone in a network means the task is gone");
  assert.ok(!names.includes("tbcode-bbbbbbbbbbbb"), "a network with a live task's sandbox in it stays");
  assert.ok(!names.includes(SHARED_NETWORK), "titanbot-net is never removed, label or no label");
  assert.ok(!names.includes("coolify"), "and neither is the proxy's own Coolify network");
});

test("the network of a container being removed goes with it", () => {
  const decided = sweepDecisions({
    containers: [ours("eeeeeeeeeeee", { "com.titanbot.deadline": String(NOW - 1) })],
    networks: [{
      id: "n", name: "tbcode-eeeeeeeeeeee",
      labels: { "com.titanbot.role": CODE_ROLE, "com.titanbot.task": "eeeeeeeeeeee" },
      members: ["titanbot-proxy-abc", "tbcode-eeeeeeeeeeee"],
    }],
    live: new Set(["eeeeeeeeeeee"]),
    nowMs: NOW,
  });
  assert.equal(decided.remove.length, 1);
  assert.deepEqual(decided.removeNetworks.map((n) => n.name), ["tbcode-eeeeeeeeeeee"],
    "a timed-out task does not leave its network behind for the next pass");
});

// ---- the sweep against a daemon that answers ----------------------------------------------------

// `inspect` answers "running" by default, because that is what a container a live row points at IS.
// It is a parameter rather than a constant because the sweep's last leg exists for the other answer:
// a task this relay still believes is running whose container stopped minutes ago. The stub used to
// answer "" to this call, which nothing made, and "" parses as a clean exit -- so the day the sweep
// started asking, a test about NOT killing a live task went red for the right reason.
function sweepWith({ ps = "", networks = [], rows = [], inspect = "running\t0\tfalse", dockerAvailable = async () => true } = {}) {
  const seen = { docker: [], closed: [], rows: [] };
  const edge = createCodeEdge({
    execFile: (file, args, opts, cb) => {
      seen.docker.push(args.join(" "));
      const key2 = `${args[0]} ${args[1]}`;
      let stdout = "";
      if (args[0] === "inspect") stdout = inspect;
      else if (key2 === "ps -a") stdout = ps;
      else if (key2 === "network ls") stdout = networks.map((n) => n.name).join("\n");
      else if (key2 === "network inspect") {
        const name = args.at(-1);
        const found = networks.find((n) => n.name === name);
        stdout = found == null ? "" : `${found.id}\t${Object.entries(found.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")},\t${(found.members ?? []).join(" ")} `;
      } else if (key2 === "ps --filter") stdout = "titanbot-proxy-abc\n";
      setImmediate(() => cb(null, stdout, ""));
    },
    readBody: async () => "{}",
    drainThenEnd: async () => {},
    workspaceOf: () => null,
    taskRootFor: () => "",
    credRootFor: () => "",
    readTasks: async () => rows,
    writeTask: async (slug, row) => { seen.rows.push(row); },
    openTask: async () => ({ ok: false }),
    closeTask: async (row) => { seen.closed.push(row); },
    dockerAvailable,
    log: () => {},
    now: () => NOW,
  });
  return { edge, seen };
}

const psLine = (taskId, deadline) => [
  `id-${taskId}`,
  `${CODE_NAME_PREFIX}${taskId}`,
  `com.titanbot.role=${CODE_ROLE},com.titanbot.tenant=demo,com.titanbot.task=${taskId},com.titanbot.agent=a_titan,com.titanbot.deadline=${deadline}`,
].join("\t");

test("a relay that restarted mid-task closes the row, removes the container, detaches the proxy", async () => {
  // This is the measured case from the gate: the relay was killed while a task ran, and the next start's
  // sweep has no memory of it at all.
  const { edge, seen } = sweepWith({
    ps: `${psLine("aaaaaaaaaaaa", NOW + 600_000)}\n`,
    networks: [{
      id: "n1", name: `${CODE_NAME_PREFIX}aaaaaaaaaaaa`,
      labels: { "com.titanbot.role": CODE_ROLE, "com.titanbot.task": "aaaaaaaaaaaa" },
      members: ["titanbot-proxy-abc", `${CODE_NAME_PREFIX}aaaaaaaaaaaa`],
    }],
    rows: [{ taskId: "aaaaaaaaaaaa", state: "running", startedAt: NOW - 120_000, claimId: 11, provider: "local" }],
  });
  const swept = await edge.sweep("this relay started");
  assert.equal(swept.containers, 1);
  assert.equal(swept.networks, 1);
  // THE CLAIM FIRST. A container removed with its row left open is an hour nobody is billed for and a
  // bot waiting on a task that will never answer.
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].id, 11);
  assert.equal(seen.closed[0].outcome, "failed");
  assert.equal(seen.closed[0].minutes, 2, "the minutes are the wall clock and not a guess");
  assert.match(seen.closed[0].detail, /restarted/);
  assert.equal(seen.rows[0].state, "failed", "and the workspace's own row says so too");
  assert.ok(seen.docker.some((line) => line.startsWith(`rm -f ${CODE_NAME_PREFIX}aaaaaaaaaaaa`)));
  assert.ok(seen.docker.some((line) => line.startsWith("network disconnect -f")));
  assert.ok(seen.docker.some((line) => line.startsWith(`network rm ${CODE_NAME_PREFIX}aaaaaaaaaaaa`)));
});

test("adopt is what keeps a restart from killing its own live tasks", async () => {
  const { edge, seen } = sweepWith({
    ps: `${psLine("bbbbbbbbbbbb", NOW + 600_000)}\n`,
    rows: [{ taskId: "bbbbbbbbbbbb", state: "running", startedAt: NOW - 60_000, claimId: 12, provider: "local" }],
  });
  // The relay reads every workspace's rows BEFORE the first sweep. Without this line a restart during a
  // thirty minute task kills the task, which is a worse failure than the one the sweep exists to fix.
  edge.adopt("demo", [{ taskId: "bbbbbbbbbbbb", state: "running", provider: "local", deadlineAt: NOW + 600_000 }]);
  assert.equal(edge.liveCount(), 1);
  const swept = await edge.sweep("this relay started");
  assert.equal(swept.containers, 0);
  assert.equal(seen.closed.length, 0);
});

test("a live task whose container has already stopped is closed by the sweep, not left saying running", async () => {
  // MEASURED ON THE R750 2026-09-10, and the reason this leg exists. A task failed in its first
  // second (the container could not write its own mount), and nothing closed it: the deadline was
  // half an hour away, the relay still had it live so it was no orphan, and /code/list -- which is
  // what the bot's watcher polls -- reads the rows as they are. The Coding strip said "running,
  // 9m 38s" ten minutes after the container had exited 2, and the bot was never told anything.
  const { edge, seen } = sweepWith({
    ps: `${psLine("cccccccccccc", NOW + 1_700_000)}\n`,
    rows: [{ taskId: "cccccccccccc", state: "running", startedAt: NOW - 90_000, claimId: 13, provider: "local" }],
    inspect: "exited\t2\tfalse",
  });
  edge.adopt("demo", [{ taskId: "cccccccccccc", state: "running", provider: "local", deadlineAt: NOW + 1_700_000 }]);
  const swept = await edge.sweep("the timer");
  assert.equal(swept.settled, 1, "the sweep is the only real wall clock, so settling is its job");
  assert.equal(seen.closed.length, 1, "the control plane's row is closed, so the minutes are billed");
  assert.equal(seen.closed[0].id, 13);
  assert.equal(seen.closed[0].outcome, "failed");
  assert.equal(seen.rows.at(-1).state, "failed", "and the workspace's own row stops saying running");
  assert.equal(edge.liveCount(), 0, "so the concurrency cap does not read one high for ever");
});

test("a live task whose container really is running is left alone by that same leg", async () => {
  const { edge, seen } = sweepWith({
    ps: `${psLine("dddddddddddd", NOW + 1_700_000)}\n`,
    rows: [{ taskId: "dddddddddddd", state: "running", startedAt: NOW - 90_000, claimId: 14, provider: "local" }],
    inspect: "running\t0\tfalse",
  });
  edge.adopt("demo", [{ taskId: "dddddddddddd", state: "running", provider: "local", deadlineAt: NOW + 1_700_000 }]);
  const swept = await edge.sweep("the timer");
  assert.equal(swept.settled, 0);
  assert.equal(seen.closed.length, 0);
  assert.equal(edge.liveCount(), 1);
});

test("a task past its deadline is closed as timed out, in the words the bot reads", async () => {
  const { edge, seen } = sweepWith({
    ps: `${psLine("cccccccccccc", NOW - 1)}\n`,
    rows: [{ taskId: "cccccccccccc", state: "running", startedAt: NOW - 31 * 60_000, claimId: 13, provider: "local" }],
  });
  edge.adopt("demo", [{ taskId: "cccccccccccc", state: "running", provider: "local", deadlineAt: NOW - 1 }]);
  await edge.sweep("the timer");
  assert.equal(seen.closed[0].outcome, "timed_out");
  assert.equal(seen.closed[0].minutes, 31);
  assert.equal(seen.rows[0].state, "timed_out");
});

test("a labelled container with no row of its own is still removed rather than left running", async () => {
  // A claim that never reached the tasks file, or a workspace whose file was lost. The container is the
  // thing costing the machine, so it goes either way.
  const { edge, seen } = sweepWith({ ps: `${psLine("dddddddddddd", NOW - 1)}\n`, rows: [] });
  const swept = await edge.sweep("the timer");
  assert.equal(swept.containers, 1);
  assert.equal(seen.closed.length, 0, "there is no claim to close");
  assert.ok(seen.docker.some((line) => line.startsWith(`rm -f ${CODE_NAME_PREFIX}dddddddddddd`)));
});

test("a relay with no docker sweeps nothing and says so rather than throwing every minute", async () => {
  const { edge, seen } = sweepWith({ dockerAvailable: async () => false });
  const swept = await edge.sweep("the timer");
  assert.equal(swept.ok, true);
  assert.equal(swept.containers, 0);
  assert.equal(seen.docker.length, 0);
  assert.match(swept.why, /no docker/);
});

test("a machine that has never run a coding task reports zero, which is how absence is told from silence", async () => {
  const { edge, seen } = sweepWith({ ps: "", networks: [] });
  const swept = await edge.sweep("this relay started");
  assert.deepEqual([swept.containers, swept.networks], [0, 0]);
  // And it never touched the shared network or the proxy on the way to finding nothing.
  assert.ok(!seen.docker.some((line) => line.includes(`network rm ${SHARED_NETWORK}`)));
  assert.ok(!seen.docker.some((line) => line.startsWith("network disconnect")));
});

test("the label filter is what the sweep lists with, both times", async () => {
  const { edge, seen } = sweepWith({ ps: "" });
  await edge.sweep("the timer");
  const ps = seen.docker.find((line) => line.startsWith("ps -a"));
  const nets = seen.docker.find((line) => line.startsWith("network ls"));
  assert.match(ps, /--filter label=com\.titanbot\.role=code-sandbox/);
  assert.match(nets, /--filter label=com\.titanbot\.role=code-sandbox/);
  // And never a name filter, which would take a reader's probe container or a gate's own.
  assert.ok(!ps.includes("name=tbcode"));
  assert.ok(!nets.includes("name=tbcode"));
});

test("the billed minutes are the minutes the container ran, not the minutes until somebody asked", async () => {
  // MEASURED ON THE R750 2026-09-10: a container that exited about a second after it started went
  // onto the operator's ledger as 16.78 minutes, because the clock stopped when the next sweep found
  // it rather than when it stopped. The operator bills from that number.
  const { edge, seen } = sweepWith({
    ps: `${psLine("eeeeeeeeeeee", NOW + 1_700_000)}\n`,
    rows: [{ taskId: "eeeeeeeeeeee", state: "running", startedAt: NOW - 900_000, claimId: 15, provider: "local" }],
    // Started fifteen minutes ago, stopped fourteen and a half minutes ago: 0.5 minutes of container.
    inspect: `exited\t2\tfalse\t${new Date(NOW - 870_000).toISOString()}`,
  });
  edge.adopt("demo", [{ taskId: "eeeeeeeeeeee", state: "running", provider: "local", deadlineAt: NOW + 1_700_000 }]);
  await edge.sweep("the timer");
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].minutes, 0.5, "half a minute of container, not fifteen minutes of waiting");
  assert.equal(seen.rows.at(-1).endedAt, NOW - 870_000, "and the workspace's own row says the same time");
});

test("a stop time docker does not have falls back to now rather than to a nonsense figure", async () => {
  for (const finishedAt of ["", "0001-01-01T00:00:00Z", "not a date"]) {
    const { edge, seen } = sweepWith({
      ps: `${psLine("ffffffffffff", NOW + 1_700_000)}\n`,
      rows: [{ taskId: "ffffffffffff", state: "running", startedAt: NOW - 120_000, claimId: 16, provider: "local" }],
      inspect: `exited\t1\tfalse\t${finishedAt}`,
    });
    edge.adopt("demo", [{ taskId: "ffffffffffff", state: "running", provider: "local", deadlineAt: NOW + 1_700_000 }]);
    await edge.sweep("the timer");
    assert.equal(seen.closed[0].minutes, 2, `a ${JSON.stringify(finishedAt)} stop time must not bill a negative or a zero`);
  }
});
