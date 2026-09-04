// What the model is actually offered, measured rather than inferred.
//
// Until this existed, the only way to read the offered toolset was a temporary tap inside the
// inference client plus a bundle rebuild (docs/audit-wave3-wire.md), so "34 tools" was a claim
// nobody could re-check. The host now writes one `[sand][toolset]` line per tool build and a
// report of which sections the assembled system prompt carried, both behind the operator switch
// SAND_TOOL_TRACE (read per call from a host settings file, so no recreate and no restart). It turns
// that switch on, drives one real turn, reads the line back out of the box, and asserts.
//
// The switch file is /home/box/sand-data/sand-host-settings.json, NOT box-secrets.json: `SAND_`
// is a reserved box-secret prefix, and one reserved key in box-secrets.json makes the applier
// drop every real secret at host start.
//
//   node scripts/verify-toolset.mjs              chief: both local-machine worlds, 30 and 35 tools, prompt sections
//   node scripts/verify-toolset.mjs --connector  a real CallMcpTool round trip, stamped evidenced
//   node scripts/verify-toolset.mjs --subagent   a computerUse subagent is offered 3 tools
//   node scripts/verify-toolset.mjs --browser    SAND_BROWSER_USE on: a browserUse subagent reads a page
//   node scripts/verify-toolset.mjs --mcp-instructions  a stored connector instruction reaches the next prompt
//   node scripts/verify-toolset.mjs --room       a shared room: members answer text only
//
// TOOLS-17. The room leg exists because the shared-room runner had never run. Of the 4,840 toolsets
// traced on this box, not one carries isSharedRoomRunner, so the filter that cuts a room member
// down to SendMessage (turn-toolset.ts SHARED_ROOM_TEXT_ONLY_TOOL_NAMES) was code nobody had
// executed. Two things had to be staged for it to run at all, and both are named in the output:
// the room binding, because a real one is installed by the cross-user relay and that needs an xAI
// login this box does not have; and the box-tools switch, which decides which of the two room sets
// applies.
//
// Integration check, not a unit test: needs the box up and a provider configured.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const PROMPT_REPORTS = "/home/box/sand-data";
const MODE = process.argv.includes("--connector")
  ? "connector"
  : process.argv.includes("--mcp-instructions") ? "mcp-instructions"
  : process.argv.includes("--browser") ? "browser"
  : process.argv.includes("--room") ? "room"
  : process.argv.includes("--subagent") ? "subagent" : "chief";
const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const DEFAULT_TIMEOUT_MS = MODE === "chief" ? 180000 : MODE === "room" ? 240000 : 420000;
const requestedTimeoutMs = Number.parseInt(flag("--timeout-ms", String(DEFAULT_TIMEOUT_MS)), 10);
if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
  console.warn(`--timeout-ms was not a positive number; using the ${MODE} default of ${DEFAULT_TIMEOUT_MS}ms`);
}
const TIMEOUT_MS = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
  ? requestedTimeoutMs
  : DEFAULT_TIMEOUT_MS;
const KEEP = process.argv.includes("--keep");

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

const TOKEN = token();
const call = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The switch is a host setting file, not container env, precisely so it can be flipped on a
// running box. Flip it, and put it back the way it was on the way out. The file need not exist:
// a missing or unparseable one means "no overrides", and the write creates it.
const readSetting = async (name) => {
  const raw = await docker(["exec", BOX, "sh", "-c", `cat ${SETTINGS} 2>/dev/null || echo '{}'`]);
  try { return JSON.parse(raw)[name]; } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null
    ? `delete d[${JSON.stringify(name)}];`
    : `d[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};
const readTrace = () => readSetting("SAND_TOOL_TRACE");
const writeTrace = (value) => writeSetting("SAND_TOOL_TRACE", value);
// TOOLS-15. The pin. The five host-machine tools swing on whether a computer is answering on the
// local-exec bridge, which is a 30 s liveness window fed by a daemon on the operator's own machine:
// nothing this gate can stage, and on a box with the desktop app running it is stuck at "connected"
// forever. So the host reads SAND_LOCAL_MACHINE first ("0" withholds, "1" offers, unset means ask
// the bridge) and the chief run drives BOTH worlds -- the live one, then the other one pinned --
// rather than asserting whichever one this box happens to be in.
const LOCAL_MACHINE = "SAND_LOCAL_MACHINE";
// TOOLS-17. The same shape for the room: whether a member answering in a shared room keeps the box
// tools beside SendMessage. It used to be read from the container environment, where nothing on a
// running box can change it, so the text-only room could never be driven at all.
const SHARED_ROOM_BOX_TOOLS = "SAND_SHARED_ROOM_BOX_TOOLS";
const AGENTS_DIR = "/home/box/sand-data/agents";

const hostLogLines = async () =>
  Number.parseInt((await docker(["exec", BOX, "sh", "-c", "wc -l < /tmp/sand-host.log"])).trim(), 10);

// Every toolset line the host wrote after `from`, newest last.
const traceLinesSince = async (from) => {
  const out = await docker(["exec", BOX, "sh", "-c",
    `tail -n +${from + 1} /tmp/sand-host.log | grep -F '[sand][toolset]' || true`]);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf("[sand][toolset] ");
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + "[sand][toolset] ".length))]; } catch { return []; }
  });
};

// Every [sand][wire] line (what actually left for the provider) written after `from`.
const wireLinesSince = async (from) => {
  const out = await docker(["exec", BOX, "sh", "-c",
    `tail -n +${from + 1} /tmp/sand-host.log | grep -F '[sand][wire]' || true`]);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf("[sand][wire] ");
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + "[sand][wire] ".length))]; } catch { return []; }
  });
};

// The gates table the host prints once at start: {gate: {value, source}}. Read the newest line,
// so a restart mid-run reports the gate this turn actually ran under.
const gateValue = async (name) => {
  const out = await docker(["exec", BOX, "sh", "-c",
    `grep -F '[sand][gates] ' /tmp/sand-host.log | tail -n 1 || true`]);
  const at = out.indexOf("[sand][gates] ");
  if (at < 0) return null;
  try { return JSON.parse(out.slice(at + "[sand][gates] ".length))[name]?.value ?? null; }
  catch { return null; }
};

// The host never writes the prompt itself out (it carries the user's memory, and every agent on
// this box shares a filesystem) -- it reports which sections it carried. Rewritten on every
// assembly, so after a turn it describes that turn.
const readPromptReport = async (id) => {
  const raw = await docker(["exec", BOX, "sh", "-c",
    `cat ${PROMPT_REPORTS}/sand-system-prompt-${id}.json 2>/dev/null || true`]);
  try { return JSON.parse(raw); } catch { return null; }
};

// TOOLS-15. The five tools bound with surface "host_machine": every one of them reaches the
// operator's own computer over the local-exec bridge, and every one of them blocks until a
// provider on that bridge answers. They are offered only while a computer is announced there. An
// operator connects one by running the desktop app's local-exec daemon against this gateway: it
// streams GET /local-exec/requests with the gateway bearer token and POSTs its frames, starting
// with a hello, back to /local-exec/responses. With the daemon down (or before its stream has
// reconnected after a host restart) nothing answers, and the five are withheld.
const HOST_MACHINE_TOOLS = ["ExternalShell", "ExternalRead", "AwaitExternalShell", "CopyToBox", "CopyFromBox"];
// Exact counts, not a range: with a computer announced the chief is offered 35 tools, without one
// 30, and anything else is a tool that appeared or vanished for some other reason.
const CHIEF_TOOL_COUNT_WITH_COMPUTER = 35;
const CHIEF_TOOL_COUNT_WITHOUT_COMPUTER = 30;

const spoken = (entries) => entries.filter((entry) => entry.kind === "send-message");

// A subagent's ledger directory once surfaced in the roster as a phantom "New Agent" with a
// materialised database. After any subagent run, the roster must hold no subagent ids.
const assertNoPhantomAgents = async () => {
  const phantoms = (await call("listAgents")).filter((a) => /^(sand-)?subagent-/.test(String(a.id)));
  if (phantoms.length > 0) fail(`${phantoms.length} subagent id(s) surfaced in the roster as agents: ${phantoms.map((a) => a.id).join(", ")}`);
};

const freshAgent = async (name, description = "") => {
  const made = await call("createAgent", {
    name, description, origin: "user", isKickstartRequested: false,
  });
  const agent = made?.agent ?? made;
  if (agent?.id == null) throw new Error("createAgent returned no agent");
  return agent;
};

const cleanUp = async (agentId) => {
  if (KEEP || agentId == null) return;
  await call("deleteAgent", { id: agentId }).catch(() => {});
  // The prompt-section report is written beside the settings file and outlives the agent otherwise.
  await docker(["exec", BOX, "sh", "-c", `rm -f ${PROMPT_REPORTS}/sand-system-prompt-${agentId}.json`]).catch(() => {});
};

// The room leg's probes: two members and the room that holds them. A room will not delete while
// its turn is still running (deleteAgent is refused mid-run, which is how a probe survived a
// passing run once), so each one is waited to idle first, room before members.
const probeIds = [];
const waitForIdle = async (id, timeoutMs = 150000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = (await call("listAgents").catch(() => [])).find((a) => a.id === id)?.isRunning === true;
    if (!running) return true;
    await sleep(4000);
  }
  return false;
};
const deleteProbe = async (id) => {
  if (KEEP || id == null) return;
  await waitForIdle(id);
  await call("deleteAgent", { id }).catch(() => {});
  await docker(["exec", BOX, "sh", "-c", `rm -f ${PROMPT_REPORTS}/sand-system-prompt-${id}.json`]).catch(() => {});
};

// Throw rather than exit: the finally below still has to delete the probe agent and put the
// operator's SAND_TOOL_TRACE back the way it found it, and process.exit skips finally blocks.
class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };

const previousTrace = await readTrace();
if (previousTrace !== "1") await writeTrace("1");
const previousLocalMachine = await readSetting(LOCAL_MACHINE);
let pinnedLocalMachine = false;
// Agents that appear during the run and are not the probe are the model's doing (CreateAgent) or a
// phantom; either way they are reported and removed so the roster ends as it started.
const rosterBefore = new Set((await call("listAgents")).map((a) => a.id));
let agent;
try {
  if (MODE === "chief" || MODE === "subagent") {
    const wantSubagent = MODE === "subagent";
    agent = await freshAgent(`verify-toolset-${Math.random().toString(36).slice(2, 8)}`);
    // One real turn, and the trace lines it wrote. Factored out because the chief run drives two.
    const driveTurn = async (prompt) => {
      const from = await hostLogLines();
      await call("sendPrompt", { agentId: agent.id, prompt });
      const deadline = Date.now() + TIMEOUT_MS;
      let chief;
      let boxScoped;
      while (Date.now() < deadline) {
        await sleep(4000);
        const lines = await traceLinesSince(from);
        chief = lines.find((line) => line.conversationId === agent.id && !line.isSubagentRunner);
        boxScoped = lines.find((line) => line.isBoxScopedSubagent && line.isComputerUseSubagent);
        if (chief != null && (!wantSubagent || boxScoped != null)) break;
      }
      return { from, chief, boxScoped };
    };
    const READY = "Reply with the single word READY.";
    const first = await driveTurn(wantSubagent
      ? "Dispatch one computerUse subagent whose only job is to take a single screenshot of "
        + "your box desktop and report what it sees. Do not do it yourself."
      : READY);
    const { from, chief, boxScoped } = first;
    if (chief == null) fail("no [sand][toolset] line for the chief; is SAND_TOOL_TRACE readable in the box?");

    console.log(`chief offered ${chief.count} tools:`);
    console.log(`  ${chief.tools.join(", ")}`);
    console.log(`Task subagent types: ${chief.subagentTypes.join(", ") || "(none)"}`);
    const withheld = chief.withheld ?? [];
    console.log(`withheld: ${withheld.map((entry) => `${entry.tool} (${entry.reason})`).join(", ") || "(none)"}`);
    const missing = ["GetMcpTools", "CallMcpTool"].filter((name) => !chief.tools.includes(name));
    if (missing.length > 0) fail(`the MCP meta pair is still withheld: missing ${missing.join(", ")}`);
    // TOOLS-15. The five host-machine tools used to be offered whether or not anything was on the
    // far end of the local-exec bridge, so a model that reached for one waited out a request nobody
    // would answer. They now swing on one fact, which the trace line reports. Asserted as the whole
    // invariant rather than a number: connected means all five offered, not connected means all
    // five absent AND each one named on the withheld list with its reason. `expected` is what this
    // leg was supposed to produce, so a host that quietly stopped answering the question fails.
    const assertLocalMachineTools = (line, expected) => {
      const seen = line.localMachineConnected;
      if (typeof seen !== "boolean") {
        fail("the toolset line does not report localMachineConnected: the withhold cannot be checked against the fact that drives it");
      }
      if (seen !== expected) {
        fail(`this turn was meant to run with ${expected ? "a computer connected" : "no computer connected"}, `
          + `but the toolset line reports localMachineConnected=${seen}`);
      }
      const named = new Map((line.withheld ?? []).map((entry) => [entry.tool, entry.reason]));
      if (expected) {
        const absent = HOST_MACHINE_TOOLS.filter((name) => !line.tools.includes(name));
        if (absent.length > 0) fail(`a computer is connected, yet ${absent.join(", ")} ${absent.length === 1 ? "was" : "were"} withheld`);
      } else {
        const offeredOfTheFive = HOST_MACHINE_TOOLS.filter((name) => line.tools.includes(name));
        if (offeredOfTheFive.length > 0) {
          fail(`no computer is connected to this box, yet the model was offered ${offeredOfTheFive.join(", ")}: `
            + "each one blocks on a local-exec channel nobody answers");
        }
        const unexplained = HOST_MACHINE_TOOLS.filter((name) => named.get(name) !== "no_local_machine");
        if (unexplained.length > 0) {
          fail(`the toolset line does not say why ${unexplained.join(", ")} ${unexplained.length === 1 ? "is" : "are"} missing: `
            + "a withheld tool has to be reported with its reason, not just absent");
        }
      }
      const expectedCount = expected ? CHIEF_TOOL_COUNT_WITH_COMPUTER : CHIEF_TOOL_COUNT_WITHOUT_COMPUTER;
      if (line.count !== expectedCount) {
        fail(`chief offered ${line.count} tools, expected ${expectedCount} with ${expected ? "a computer connected" : "no computer connected"}`);
      }
    };
    // The prompt half. The base prompt used to spend paragraphs on the two machines and the file
    // transfers between them whether or not either tool was in the toolset. The section marker is
    // the "separate machines" paragraph of the box section, and it has to move with the five tools:
    // teaching a tool the model was never handed is the whole failure.
    const assertLocalMachinePrompt = (promptReport, expected) => {
      const hasSection = promptReport.sections?.localMachine === true;
      console.log(`two-machines prompt section: ${hasSection ? "present" : "absent"}`);
      if (expected !== hasSection) {
        fail(expected
          ? "a computer is connected and the five host-machine tools were offered, but the assembled prompt dropped the \"separate machines\" paragraph that explains them"
          : "no computer is connected, yet the assembled prompt still carries the \"separate machines\" paragraph: "
            + "it teaches ExternalShell, ExternalRead and CopyToBox/CopyFromBox, none of which were offered");
      }
    };
    const connected = chief.localMachineConnected;
    console.log(`local machine: ${connected ? "announced on the local-exec bridge" : "none connected"}`
      + ` (source: ${chief.localMachineSource ?? "(absent)"})`);
    assertLocalMachineTools(chief, connected);
    // What the provider was actually sent must be what the toolset offered (CLOUD-1 was a silent 36 -> 35).
    // Selected by conversation, not by count: matching on `offered === chief.count` accepted any
    // request that happened to carry the same number of tools, so a tool dropped between the
    // toolset build and the request would have been papered over by another agent's line.
    const assertWire = async (line, from) => {
      const wire = (await wireLinesSince(from)).find((entry) => entry.conversationId === agent.id);
      if (wire == null) fail(`no [sand][wire] line carrying conversationId ${agent.id}`);
      console.log(`wire: ${wire.transport} ${wire.model} offered ${wire.offered} sent ${wire.sent}`);
      if (wire.offered !== line.count) fail(`the toolset built ${line.count} tools but the request offered ${wire.offered}`);
      if (wire.sent !== wire.offered) fail(`the provider request dropped ${wire.offered - wire.sent} tool(s): ${line.tools.filter((name) => !wire.tools.includes(name)).join(", ")}`);
    };
    await assertWire(chief, from);

    const report = await readPromptReport(agent.id);
    if (report == null) fail("no assembled system prompt report was written for this agent");
    const present = Object.entries(report.sections ?? {})
      .filter(([, has]) => has === true).map(([name]) => name);
    console.log(`assembled system prompt: ${report.length} chars; sections present: `
      + `${present.join(", ") || "(none)"}`);
    const absent = ["memory", "routines"].filter((name) => report.sections?.[name] !== true);
    if (absent.length > 0) {
      fail(`the assembled prompt is still missing the ${absent.join(" and ")} section(s)`);
    }
    // SP-3. The spotlight gate is two halves that must flip together: results wrapped in the
    // untrusted-data fence, and the prompt section that tells the agent what a fence means. Only
    // the fences were observable, so a prompt that promised nothing while results arrived fenced
    // (or the reverse) looked identical from out here. The gates table says which way the gate is
    // set on this box, and the prompt section has to agree with it.
    const spotlightOn = await gateValue("sand_spotlight");
    if (spotlightOn == null) {
      console.log("  INFO  no [sand][gates] line on this box; the spotlight prompt section is unchecked");
    } else {
      const hasSection = report.sections?.spotlight === true;
      console.log(`spotlight gate ${spotlightOn ? "on" : "off"}; untrusted-data prompt section ${hasSection ? "present" : "absent"}`);
      if (spotlightOn !== hasSection) {
        fail(spotlightOn
          ? "sand_spotlight is on but the assembled prompt carries no untrusted-data section: results arrive fenced with nothing telling the agent what a fence means"
          : "sand_spotlight is off but the assembled prompt still carries the untrusted-data section: it promises fences that never arrive");
      }
    }
    assertLocalMachinePrompt(report, connected);

    // TOOLS-15, the second leg. The turn above ran in whichever world this box happens to be in,
    // and on a box with the desktop app attached that is always the connected one -- so on its own
    // it cannot tell the withhold working from a host that answers "connected" no matter what.
    // This pins the OTHER world with SAND_LOCAL_MACHINE and drives a second turn, so both legs are
    // measured on every run and a change gone inert fails here. The pin is put back in the finally.
    if (!wantSubagent) {
      const pin = connected ? "0" : "1";
      console.log(`pinning ${LOCAL_MACHINE}=${pin}: driving the ${connected ? "withheld" : "connected"} world`);
      pinnedLocalMachine = true;
      await writeSetting(LOCAL_MACHINE, pin);
      const second = await driveTurn(READY);
      if (second.chief == null) fail(`no [sand][toolset] line for the turn pinned with ${LOCAL_MACHINE}=${pin}`);
      if (second.chief.localMachineSource !== "setting") {
        fail(`${LOCAL_MACHINE}=${pin} was written into the host settings file but the toolset line still reports `
          + `its source as ${JSON.stringify(second.chief.localMachineSource ?? null)}: the pin never reached the host`);
      }
      console.log(`pinned: chief offered ${second.chief.count} tools; withheld: `
        + `${(second.chief.withheld ?? []).map((entry) => `${entry.tool} (${entry.reason})`).join(", ") || "(none)"}`);
      assertLocalMachineTools(second.chief, !connected);
      await assertWire(second.chief, second.from);
      const secondReport = await readPromptReport(agent.id);
      if (secondReport == null) fail("no assembled system prompt report was written for the pinned turn");
      console.log(`pinned assembled system prompt: ${secondReport.length} chars`);
      assertLocalMachinePrompt(secondReport, !connected);
      await writeSetting(LOCAL_MACHINE, previousLocalMachine ?? null);
      pinnedLocalMachine = false;
    }

    if (wantSubagent) {
      if (boxScoped == null) fail("no box-scoped computerUse toolset line; the dispatch never ran");
      console.log(`computerUse subagent offered ${boxScoped.count} tools: ${boxScoped.tools.join(", ")}`);
      if (boxScoped.count !== 3) fail(`computerUse subagent offered ${boxScoped.count} tools, expected 3`);
      // A box-scoped subagent must get a box-scoped PROMPT too, not the chief's: the time-zone
      // section is the marker getTimeZoneSection() suppresses for exactly this runner.
      const childReport = boxScoped.conversationId == null
        ? null
        : await readPromptReport(boxScoped.conversationId);
      if (childReport == null) {
        console.log("computerUse subagent prompt report: not written before the poll ended");
      } else {
        console.log(`computerUse subagent prompt: ${childReport.length} chars; sections present: `
          + `${Object.entries(childReport.sections ?? {}).filter(([, has]) => has === true)
            .map(([name]) => name).join(", ") || "(none)"}`);
        if (childReport.sections?.timeZone === true) {
          fail("the box-scoped subagent was handed the chief's prompt (time-zone section present)");
        }
      }
    }
    await assertNoPhantomAgents();
    console.log(`PASS — ${MODE}`);
  }

  if (MODE === "room") {
    // The switch that picks the room's tool set. Off for this run and restored below: with it on a
    // member keeps the box surface as private scratch, off it is offered SendMessage and nothing
    // else, which is the set the product's own promise describes ("Bot-to-group handoff messages
    // are currently text-only" -- vendor-docs/chat-and-collaboration.md). Both sets are pinned as
    // units in tests/turn-toolset-projection.test.mjs; this leg proves the one a real turn gets.
    const previousRoomBoxTools = await readSetting(SHARED_ROOM_BOX_TOOLS);
    await writeSetting(SHARED_ROOM_BOX_TOOLS, "0");
    try {
      const stamp = Math.random().toString(36).slice(2, 8);
      const alphaName = `probe-u2-room-alpha-${stamp}`;
      const bravoName = `probe-u2-room-bravo-${stamp}`;
      const alpha = await freshAgent(alphaName, "A probe that opens the exchange and hands off.");
      probeIds.push(alpha.id);
      const bravo = await freshAgent(bravoName, "A probe that answers the handoff and stops.");
      probeIds.push(bravo.id);
      const madeRoom = await call("createGroup", {
        name: `probe-u2-room-${stamp}`,
        description: "Shared-room toolset probe.",
        memberAgentIds: [alpha.id, bravo.id],
      });
      const room = madeRoom?.agent ?? madeRoom;
      if (room?.id == null) fail("createGroup returned no room agent");
      probeIds.unshift(room.id);
      console.log(`room ${room.id} holds ${alpha.id} (${alphaName}) and ${bravo.id} (${bravoName})`);

      // What makes this room a SHARED room rather than a local group: a sharedRoomId in the room's
      // group.json. In the product that field is written by the cross-user relay when it installs a
      // room (ensureHostedSharedRoom), which needs an xAI login and the sand_multiplayer gate --
      // neither of which exists on this box, and the reason this path had never run here. The
      // binding is staged the way the relay writes it; everything after this point is the host's
      // own code deciding what a room member may reach.
      const sharedRoomId = `probe-u2-shared-${stamp}`;
      const groupPath = `${AGENTS_DIR}/${room.id}/group.json`;
      await docker(["exec", BOX, "node", "-e",
        `const fs=require('fs');const p=${JSON.stringify(groupPath)};`
        + `const d=JSON.parse(fs.readFileSync(p,'utf8'));d.sharedRoomId=${JSON.stringify(sharedRoomId)};`
        + `fs.writeFileSync(p,JSON.stringify(d));`]);
      const bound = await docker(["exec", BOX, "sh", "-c", `cat ${groupPath}`]);
      console.log(`room binding: ${bound.trim()}`);
      if (!bound.includes(sharedRoomId)) fail("the shared-room binding did not stick in the room's group.json");

      const from = await hostLogLines();
      const memberIds = new Set([alpha.id, bravo.id]);
      await call("sendPrompt", {
        agentId: room.id,
        prompt: `@${alphaName} say exactly "ALPHA ${stamp}" and hand the turn to @${bravoName} by name. `
          + `@${bravoName} reply with exactly "BRAVO ${stamp}". One short message each, then "(pass)" on any later turn.`,
      });
      const deadline = Date.now() + TIMEOUT_MS;
      const memberLines = new Map();
      let roomLine;
      let spokenByMembers = [];
      let running = true;
      while (Date.now() < deadline) {
        await sleep(4000);
        for (const line of await traceLinesSince(from)) {
          if (line.conversationId === room.id) roomLine ??= line;
          if (memberIds.has(line.conversationId)) memberLines.set(line.conversationId, line);
        }
        spokenByMembers = spoken(await call("getAgentTranscript", { id: room.id }).catch(() => []))
          .filter((entry) => memberIds.has(entry.author?.id));
        running = (await call("listAgents")).find((a) => a.id === room.id)?.isRunning === true;
        const authors = new Set(spokenByMembers.map((entry) => entry.author.id));
        if (memberLines.size === 2 && authors.size === 2 && !running) break;
      }
      console.log(`room turn ${running ? "still running at the deadline" : "finished"}; `
        + `${memberLines.size} member toolset line(s), ${spokenByMembers.length} member message(s)`);

      // (a) The runner ran as a room runner at all.
      for (const [id, name] of [[alpha.id, alphaName], [bravo.id, bravoName]]) {
        const line = memberLines.get(id);
        if (line == null) fail(`no [sand][toolset] line for ${name} (${id}): its member turn never built a toolset`);
        console.log(`${name} offered ${line.count} tool(s): ${line.tools.join(", ")} `
          + `(isSharedRoomRunner=${line.isSharedRoomRunner}, sharedRoomBoxTools=${String(line.sharedRoomBoxTools)})`);
        if (line.isSharedRoomRunner !== true) {
          fail(`${name} answered in a room bound to ${sharedRoomId} but its toolset line reports `
            + "isSharedRoomRunner=false: the member ran with the full chief toolset");
        }
        // (b) The set is the text-only room set, exactly. The switch is reported on the line, so a
        // run where the pin never reached the host says so instead of blaming the filter.
        if (line.sharedRoomBoxTools !== false) {
          fail(`${SHARED_ROOM_BOX_TOOLS}=0 was written into the host settings file but ${name}'s toolset line `
            + `reports sharedRoomBoxTools=${String(line.sharedRoomBoxTools)}: the pin never reached the host`);
        }
        if (line.tools.length !== 1 || line.tools[0] !== "SendMessage") {
          fail(`${name} was offered ${line.tools.join(", ") || "(nothing)"} in a text-only room, expected SendMessage alone`);
        }
      }
      // The room agent itself never takes a model turn; it orders the members and holds the
      // transcript. A toolset built against the room's own id would mean an extra paid turn.
      if (roomLine != null) fail(`the room agent built its own toolset (${roomLine.count} tools): a room must not run a turn of its own`);

      // (c) Both replies landed in the room transcript, under their own author ids.
      for (const entry of spokenByMembers) {
        console.log(`  ${entry.author.name} (${entry.author.id}): ${String(entry.message?.content ?? "").slice(0, 120)}`);
      }
      const authors = new Set(spokenByMembers.map((entry) => entry.author.id));
      if (authors.size !== 2) {
        fail(`the room transcript carries messages from ${authors.size} member(s), expected both: `
          + `${[...authors].join(", ") || "(none)"}`);
      }
      // (d) Nothing a member did reached the box. Structurally it could not -- no box tool was
      // offered -- and the members' own ledgers are the receipt: a fresh probe that ran a shell or
      // any tool but SendMessage would have a row here.
      for (const [id, name] of [[alpha.id, alphaName], [bravo.id, bravoName]]) {
        const ledger = await docker(["exec", BOX, "sh", "-c",
          `cat ${AGENTS_DIR}/${id}/audit.jsonl 2>/dev/null || true`]);
        const rows = ledger.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        const reached = rows.filter((row) => row.type === "shell_command" || (row.tool != null && row.tool !== "SendMessage"));
        console.log(`${name} action ledger: ${rows.length} row(s), ${reached.length} of them a tool that touches the box`);
        if (reached.length > 0) {
          fail(`${name} reached the box from a text-only room: ${reached.map((row) => row.tool ?? row.type).join(", ")}`);
        }
      }
      await assertNoPhantomAgents();
      console.log("PASS — room");
    } finally {
      await writeSetting(SHARED_ROOM_BOX_TOOLS, previousRoomBoxTools ?? null).catch(() => {});
    }
  }

  if (MODE === "browser") {
    // The browser switch is flipped for this run only and restored in the finally below.
    const previousBrowser = await readSetting("SAND_BROWSER_USE");
    if (previousBrowser !== "1") await writeSetting("SAND_BROWSER_USE", "1");
    try {
      agent = await freshAgent(`verify-browser-${Math.random().toString(36).slice(2, 8)}`);
      const from = await hostLogLines();
      await call("sendPrompt", {
        agentId: agent.id,
        prompt: "Dispatch one browserUse subagent whose only job is to open https://example.com "
          + "with its browser tools, read the page's main heading, and report the exact heading "
          + "text back to you. Do not do it yourself. When it reports, tell me the heading text verbatim.",
      });
      const deadline = Date.now() + TIMEOUT_MS;
      let chief; let child; let wire; let reply; let running = true; let browserSub; let lastReplyBeforeDone;
      // The parent answers once when it dispatches ("I'll report when it returns") and again
      // when the child revives it, so a reply alone is not the end: wait for the browserUse
      // subagent to reach done/error and the parent to go idle after that.
      while (Date.now() < deadline) {
        await sleep(6000);
        const lines = await traceLinesSince(from);
        chief ??= lines.find((line) => line.conversationId === agent.id && !line.isSubagentRunner);
        child ??= lines.find((line) => line.isBrowserUseSubagent);
        wire ??= (await wireLinesSince(from)).find((line) => line.tools.includes("browser_navigate"));
        const subs = await call("getSubagents", { id: agent.id }).catch(() => []);
        browserSub = subs.find((s) => String(s.subagentType ?? "").toLowerCase().replace(/[-_]/g, "") === "browseruse") ?? browserSub;
        const subDone = browserSub != null && (browserSub.status === "done" || browserSub.status === "error");
        running = (await call("listAgents")).find((a) => a.id === agent.id)?.isRunning === true;
        reply = spoken(await call("getAgentTranscript", { id: agent.id })).at(-1);
        // The child's report revives the parent for one more turn; the reply that counts is one
        // written after the child finished. Remember the last reply seen while the child was still
        // running, so a revival reply that lands in the same poll as "done" is not mistaken for it.
        if (!subDone) lastReplyBeforeDone = reply?.id ?? lastReplyBeforeDone;
        const revived = subDone && reply != null && reply.id !== lastReplyBeforeDone;
        if (chief && child && wire && revived && !running) break;
        if (chief && child && wire && subDone && !running && Date.now() - deadline > -TIMEOUT_MS / 2) break;
      }
      console.log(`browserUse subagent status: ${browserSub?.status ?? "(never appeared)"}`);
      // What the child actually did, from its own ledger: tool, ok flag, head of the result.
      if (child?.conversationId) {
        const ledger = await docker(["exec", BOX, "sh", "-c",
          `cat /home/box/sand-data/agents/${child.conversationId}/audit.jsonl 2>/dev/null || true`]);
        for (const line of ledger.split("\n").filter(Boolean)) {
          try {
            const row = JSON.parse(line);
            if (row.type === "tool_result") console.log(`  child ${row.tool}: ${String(row.head ?? "").slice(0, 140).replace(/\s+/g, " ")}`);
          } catch {}
        }
      }
      if (chief == null) fail("no [sand][toolset] line for the chief");
      console.log(`Task subagent types: ${chief.subagentTypes.join(", ")}`);
      if (!chief.subagentTypes.includes("browserUse")) fail("browserUse is not in Task's enum with SAND_BROWSER_USE on");
      if (child == null) fail("no browserUse subagent toolset line; the dispatch never ran");
      const browserTools = child.tools.filter((name) => name.startsWith("browser_"));
      console.log(`browserUse subagent offered ${child.count} tools, ${browserTools.length} browser_*`);
      if (browserTools.length !== 15) fail(`expected 15 browser_* tools offered, got ${browserTools.length}`);
      if (wire == null) fail("no [sand][wire] request carried browser_navigate: the tools were offered but never sent");
      console.log(`wire: ${wire.transport} ${wire.model} offered ${wire.offered} sent ${wire.sent}`);
      if (wire.sent !== wire.offered) fail(`the provider request dropped ${wire.offered - wire.sent} tool(s)`);
      const childReport = child.conversationId == null ? null : await docker(["exec", BOX, "sh", "-c",
        `cat ${PROMPT_REPORTS}/sand-system-prompt-${child.conversationId}.json 2>/dev/null || true`]).then((raw) => { try { return JSON.parse(raw); } catch { return null; } });
      if (childReport?.sections?.browser !== true) fail("the browserUse subagent's prompt has no Browser section");
      console.log(`browserUse subagent prompt: ${childReport.length} chars, Browser section present`);
      const text = String(reply?.message?.content ?? "");
      console.log(`reply: ${text.slice(0, 200)}`);
      // The wiring proof is the child's own receipt: a browser_snapshot or browser_navigate result
      // that carries the heading. Whether the parent relays it is model behaviour: on 2026-09-03
      // qwen3.8-max and once Codex were revived, made further requests, and ended their turns
      // without speaking (the silent-worker pattern; the delivery-owed reminder is behind a gate
      // that defaults off here). That is reported, not failed.
      const childLedger = child?.conversationId
        ? await docker(["exec", BOX, "sh", "-c", `cat /home/box/sand-data/agents/${child.conversationId}/audit.jsonl 2>/dev/null || true`])
        : "";
      const childSawHeading = /example domain/i.test(childLedger);
      if (!childSawHeading) fail("the browser child never captured the page heading (no receipt carries \"Example Domain\")");
      if (!/example domain/i.test(text)) console.log("WARN — the parent was revived but never relayed the heading (model behaviour; wiring proven by the child's receipt)");
      // SUB-2: the driver's screenshot reached the model as an image part at least once.
      const imageLines = (await docker(["exec", BOX, "sh", "-c",
        `tail -n +${from + 1} /tmp/sand-host.log | grep -c -F '[sand][image] rendered' || true`])).trim();
      console.log(`screenshots rendered for the model this run: ${imageLines}`);
      if (Number(imageLines) < 1) fail("no browser screenshot reached the model as an image part ([sand][image] never logged)");
      // SUB-2b. That [sand][image] line is printed where the tool RENDERS its result; it proves
      // the render, not the request. These two counts, off the [sand][wire] lines, are about the
      // request: image parts sitting in the turn's message history, and image parts that survived
      // into what left for the provider. On the runner path the second is structurally zero --
      // conversationInput/flattenParts (source/host/extensions/inference/provider-session.ts)
      // reads only a tool result's `result` string and has no image branch, so the rendered image
      // in `experimental_content` never becomes an image_url part for responsesInput to turn into
      // an input_image. Reported, not failed: the fix is a change to that flattening, not to this
      // gate, and a gate that fails on a known hole stops telling anyone anything new.
      const wireLines = await wireLinesSince(from);
      const inHistory = Math.max(0, ...wireLines.map((line) => Number(line.historyImageParts ?? 0)));
      const onWire = Math.max(0, ...wireLines.map((line) => Number(line.imageParts ?? 0)));
      console.log(`image parts: ${inHistory} in the turn history, ${onWire} in the request that left`);
      if (inHistory > 0 && onWire === 0) fail("SUB-2b: every rendered image was dropped before the request left; the history flattener lost the image part");
      else if (inHistory > 0) console.log("PASS - the rendered screenshot left in the request as an image part");
      await assertNoPhantomAgents();
      console.log("PASS — browser");
    } finally {
      if (previousBrowser !== "1") await writeSetting("SAND_BROWSER_USE", previousBrowser).catch(() => {});
    }
  }

  if (MODE === "mcp-instructions") {
    // TOOLS-13. A connector instruction stored in host settings must render into the next prompt.
    //
    // There are two stores behind that one section, and until CP-07 only one of them could be
    // exercised here: instructions keyed by SERVER ID were unreachable for a local connector,
    // because its id was `local:localfiles` and every id-keyed path runs the id through
    // validateMcpServerId. So this drove the legacy name-keyed map and called it proven. Now that
    // local connectors carry a real numeric id, both legs run: the name-keyed map first, then the
    // id-keyed map alone (with the name-keyed one cleared), so the second leg cannot be carried by
    // the first. SetMcpInstructions through a model turn is expensive; these are settings writes.
    const before = await call("getHostSettings");
    const previous = before?.mcpCustomInstructions ?? {};
    const previousById = before?.mcpCustomInstructionsByServerId ?? {};
    const installed = await call("listInstalledMcpServers").catch(() => []);
    const localfiles = (Array.isArray(installed) ? installed : []).find((server) => server.serverIdentifier === "localfiles");
    const serverId = localfiles == null ? null : String(localfiles.id);
    if (serverId == null) fail("listInstalledMcpServers does not show the localfiles connector");
    if (!/^[1-9]\d*$/.test(serverId)) fail(`localfiles id "${serverId}" is not a positive decimal string; the id-keyed store cannot be reached`);
    console.log(`localfiles server id: ${serverId}`);
    const probe = `VERIFY-MCP-INSTRUCTIONS-${Math.random().toString(36).slice(2, 8)}`;
    const reportPath = (id) => `${PROMPT_REPORTS}/sand-system-prompt-${id}.json`;
    const awaitReport = async (id) => {
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(4000);
        const raw = await docker(["exec", BOX, "sh", "-c", `cat ${reportPath(id)} 2>/dev/null || true`]);
        try { const parsed = JSON.parse(raw); if (parsed != null) return parsed; } catch {}
      }
      return null;
    };
    try {
      // Leg 1: the legacy name-keyed map.
      await call("setHostSettings", { mcpCustomInstructions: { ...previous, localfiles: probe }, mcpCustomInstructionsByServerId: {} });
      agent = await freshAgent(`verify-mcpi-${Math.random().toString(36).slice(2, 8)}`);
      await docker(["exec", BOX, "sh", "-c", `rm -f ${reportPath(agent.id)}`]);
      await call("sendPrompt", { agentId: agent.id, prompt: "Reply with the single word READY." });
      const report = await awaitReport(agent.id);
      if (report == null) fail("no assembled prompt report was written for the probe agent");
      console.log(`by name — prompt sections: ${Object.entries(report.sections ?? {}).filter(([, has]) => has === true).map(([name]) => name).join(", ")}`);
      if (report.sections?.mcpCustomInstructions !== true) fail("the name-keyed connector instruction did not reach the assembled prompt (mcpCustomInstructions section absent)");

      // Leg 2: the id-keyed map ALONE. Nothing name-keyed is left to carry the section.
      await call("setHostSettings", { mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: { [serverId]: `${probe}-BY-ID` } });
      await docker(["exec", BOX, "sh", "-c", `rm -f ${reportPath(agent.id)}`]);
      await call("sendPrompt", { agentId: agent.id, prompt: "Reply with the single word READY again." });
      const byId = await awaitReport(agent.id);
      if (byId == null) fail("no assembled prompt report was written for the id-keyed leg");
      console.log(`by id — prompt sections: ${Object.entries(byId.sections ?? {}).filter(([, has]) => has === true).map(([name]) => name).join(", ")}`);
      if (byId.sections?.mcpCustomInstructions !== true) fail(`the instruction stored under mcpCustomInstructionsByServerId[${serverId}] did not reach the assembled prompt`);
      console.log("PASS — mcp-instructions");
    } finally {
      // The report is written while the turn is still being built, so the checks above return with
      // the agent mid-run and cleanUp's deleteAgent would be refused -- which is how a probe agent
      // survived a passing run. Wait for idle before the roster check.
      if (agent != null) {
        const idleBy = Date.now() + 120000;
        while (Date.now() < idleBy) {
          if ((await call("listAgents").catch(() => [])).find((a) => a.id === agent.id)?.isRunning !== true) break;
          await sleep(4000);
        }
      }
      await call("setHostSettings", { mcpCustomInstructions: previous, mcpCustomInstructionsByServerId: previousById }).catch(() => {});
    }
  }

  if (MODE === "connector") {
    const servers = await call("listRoutedMcpTools").catch(() => []);
    const names = [...new Set(servers.map((tool) => tool.providerIdentifier))];
    console.log(`routed connector tools: ${servers.length} across ${names.join(", ") || "(none)"}`);
    if (servers.length === 0) fail("no connector tools are routed; nothing to prove");

    agent = await freshAgent(`verify-mcp-${Math.random().toString(36).slice(2, 8)}`);
    // "verbatim" is test hygiene, not a thumb on the scale: the evidence rule is literal
    // containment (docs/EVIDENCE-CONTRACT.md), so a reply that helpfully rewrites
    // `proof-123.txt` as `/workspace/proof-123.txt` is stamped `unsupported` for a token the
    // tool never returned. Asking for the names as the tool gave them tests the plumbing
    // rather than the model's formatting taste. The receipt assertion below is unaffected.
    await call("sendPrompt", {
      agentId: agent.id,
      prompt: "Use your MCP tools to list the files under /workspace and tell me how many there "
        + "are. Give the entry names exactly as the tool returned them, with no path prefix added.",
    });

    // CallMcpTool's outline row is named for the generated tool call, `mcpToolCall`; the
    // discovery half shows up as `getMcpToolsToolCall`. Both must be the real pair, so the row
    // also has to name a connector server in its arguments.
    const deadline = Date.now() + TIMEOUT_MS;
    let reply;
    let mcpRow;
    while (Date.now() < deadline) {
      await sleep(6000);
      const outline = await call("getConversationOutline", { id: agent.id }).catch(() => []);
      mcpRow = (Array.isArray(outline) ? outline : []).find((row) =>
        row.kind === "tool-call"
        && /^(mcpToolCall|callMcpToolToolCall)$/i.test(String(row.name ?? ""))
        && names.some((server) => String(row.summary ?? "").includes(server)));
      const running = (await call("listAgents")).find((a) => a.id === agent.id)?.isRunning === true;
      reply = spoken(await call("getAgentTranscript", { id: agent.id })).at(-1);
      if (mcpRow != null && reply != null && !running) break;
    }
    if (mcpRow == null) fail("no CallMcpTool row in the conversation outline; the model never reached the connector");
    console.log(`CallMcpTool receipt: ${mcpRow.name} status=${mcpRow.status} ${String(mcpRow.summary ?? "").slice(0, 160)}`);
    if (reply == null) fail("the agent called the connector but never delivered a reply");
    console.log(`reply: ${String(reply.message?.content ?? "").slice(0, 200)}`);
    const verdict = reply.evidence?.verdict;
    console.log(`evidence verdict: ${verdict ?? "no stamp"}`);
    if (verdict !== "evidenced") {
      fail(`reply verdict is ${verdict ?? "absent"}, expected evidenced`
        + `${reply.evidence?.missing?.length ? ` (missing ${reply.evidence.missing.slice(0, 3).join(", ")})` : ""}`);
    }
    console.log("PASS — connector");
  }
} catch (error) {
  if (!(error instanceof VerificationFailed)) throw error;
  console.error(`FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanUp(agent?.id);
  // Room before members: deleting a member out from under a live room turn leaves the room holding
  // an id that no longer exists.
  for (const id of probeIds) await deleteProbe(id);
  try {
    const extras = (await call("listAgents")).filter((a) => !rosterBefore.has(a.id) && a.id !== agent?.id);
    for (const extra of extras) {
      console.log(`WARN — an agent appeared during the run and was removed: ${JSON.stringify(extra.name)} (${extra.id}, origin ${extra.origin ?? "?"})`);
      await call("deleteAgent", { id: extra.id }).catch(() => {});
    }
  } catch {}
  if (previousTrace !== "1") await writeTrace(previousTrace).catch(() => {});
  // The pin is the operator's box-wide switch, so it goes back exactly as found, deleted if it was
  // never there. A run that dies mid-leg must not leave the five withheld on a live box.
  if (pinnedLocalMachine) await writeSetting(LOCAL_MACHINE, previousLocalMachine ?? null).catch(() => {});
}
