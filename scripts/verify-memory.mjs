// Durable memory, end to end, on a box that has never logged in to Cursor.
//
// What was broken: memory synthesis is armed in exactly one place, inside
// pinGateOnAuthenticatedBootstrap("sand_memory_dreaming") in the memory extension. That listener
// only ever fires after an authenticated Statsig bootstrap, which needs a Cursor login, so on this
// box it never fired. Unarmed, MemoryService.createAgentStore hands the runner a store whose
// recordMemoryEvidence getter is undefined, turn-settle therefore skips runTurnMemory for every
// ordinary turn, and nothing is ever written: `find /home/box/sand-data/agents -name '*.md'` found
// no memory file at all. There is now a host switch, SAND_MEMORY_DREAMING, read at host start the
// way SAND_TEACH is read per call.
//
// What the loop actually is, and what this gate walks:
//   1. A turn settles. turn-settle calls runTurnMemory, which (with synthesis armed) hands the
//      exchange to MemorySynthesisService.recordTurn as evidence instead of running the old
//      inline extraction.
//   2. recordTurn debounces 15s, then runs one proposal and one verification pass through the
//      ROUTED provider session -- inference.port.createSession, which for any provider other than
//      cursor returns createProviderPromptSession. Nothing about synthesis is Cursor-only.
//   3. An approved proposal is applied to the agent's own memory folder on the box:
//      agents/<id>/memory/profile.md and memory/log/<YYYY-MM>.md, plain markdown fact lines.
//   4. The next turn's system prompt renders those files (renderMemorySystemPrompt), so the fact
//      reaches the model without being in the conversation.
//
// The arming happens once, at host start, so this gate needs a host that STARTED with the switch
// on. If it finds one that did not, it sets the switch and restarts the box, which is why it says
// so loudly: this box is shared.
//
// Integration check, not a unit test: needs the box up, a provider configured, and real turns.
//
//   node scripts/verify-memory.mjs                 runs and puts SAND_MEMORY_DREAMING back
//   node scripts/verify-memory.mjs --keep-setting  leaves SAND_MEMORY_DREAMING="1" on for this box
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const SETTING = "SAND_MEMORY_DREAMING";
const KEEP_SETTING = process.argv.includes("--keep-setting");

// The whole run has to fit the 300s warden ceiling with room for the cleanup in the finally, so
// every wait below is clamped against one deadline rather than budgeted on its own.
const TOTAL_BUDGET_MS = 225_000;
const TURN_TIMEOUT_MS = 75_000;
// MEMORY_SYNTHESIS_DEBOUNCE_MS is 15s, then one proposal and one verification call.
const SYNTHESIS_TIMEOUT_MS = 105_000;
const RESTART_TIMEOUT_MS = 120_000;
const PROBE_IDLE_TIMEOUT_MS = 20_000;
const FACT_PRINTER = "Brother on the second floor";
const FACT_EXTENSION = "4417";
const TRIP_CITY = "Denver";

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
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
};

const docker = (args, timeoutMs = 180_000) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20, timeout: timeoutMs }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));
const sh = (command) => docker(["exec", BOX, "sh", "-c", command]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throw rather than exit: the finally below still has to put the operator's switch back and delete
// the probe agent, and process.exit skips finally blocks.
class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
const pass = (message) => console.log(`PASS - ${message}`);

const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
const remaining = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
// Every wait is the smaller of its own timeout and what is left of the budget, so a slow step
// cannot eat the cleanup.
const deadlineFor = (ms) => Date.now() + Math.max(0, Math.min(ms, remaining()));

// readSettingsFile (source/host/sand-box-setting.ts) takes either a flat object or
// { settings: { ... } } and PREFERS the nested one, so both helpers resolve the container the
// reader picks. Writing only the top level of an operator's nested file would move a key the
// resolver never consults and the restore would then invent one.
const settingsContainer = "const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;";
const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const nested = parsed.settings;
    const source = nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed;
    return source[name];
  } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null
    ? `delete c[${JSON.stringify(name)}];`
    : `c[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + settingsContainer
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

const hostLogLines = async () =>
  Number.parseInt((await sh("wc -l < /tmp/sand-host.log")).trim(), 10);
const logLinesSince = async (from, tag) =>
  (await sh(`tail -n +${from + 1} /tmp/sand-host.log | grep -F '${tag}' || true`))
    .split("\n").map((line) => line.trim()).filter(Boolean);
const lastLogLine = async (tag) => (await sh(`grep -F '${tag}' /tmp/sand-host.log | tail -1 || true`)).trim();

// The prompt section report the host writes per agent behind SAND_TOOL_TRACE. It is the only
// honest window on the assembled prompt: the prompt itself carries the user's memory and every
// agent on this box shares a filesystem, so nothing writes it out.
const promptReport = async (agentId) => {
  const raw = (await sh(`cat /home/box/sand-data/sand-system-prompt-${agentId}.json 2>/dev/null || true`)).trim();
  if (raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const said = (entries) => (Array.isArray(entries) ? entries : []).filter((entry) => {
  if (entry.kind === "send-message") return String(entry.message?.content ?? "").trim().length > 0;
  return entry.kind === "message" && entry.role === "assistant" && String(entry.content ?? "").trim().length > 0;
});
const text = (entry) => entry.kind === "send-message" ? entry.message.content : entry.content;

const isRunning = async (agentId) =>
  (await call("listAgents").catch(() => [])).find((agent) => agent.id === agentId)?.isRunning === true;

// One turn, and wait for the agent to actually answer: settlement is what hands the exchange to
// synthesis, and a prompt that was never answered has recorded no evidence.
//
// Waiting for the agent to go idle first is not politeness. A freshly opened agent greets on its
// own, and counting transcript growth from before that greeting reported "answered" in seven
// seconds against a turn that had not been sent yet.
const turn = async (agentId, prompt, label) => {
  const idleBy = deadlineFor(TURN_TIMEOUT_MS);
  while (Date.now() < idleBy && await isRunning(agentId)) await sleep(3000);
  const before = said(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", { agentId, prompt });
  const by = deadlineFor(TURN_TIMEOUT_MS);
  while (Date.now() < by) {
    await sleep(3000);
    const answers = said(await call("getAgentTranscript", { id: agentId }));
    if (answers.length > before) {
      const answer = String(text(answers.at(-1))).replace(/\s+/g, " ");
      console.log(`${label} answered (${elapsed()}): ${JSON.stringify(answer.slice(0, 240))}`);
      return answer;
    }
    const failure = (await call("getTrays").catch(() => []))
      .find((tray) => tray.agentId === agentId && tray.kind === "error");
    if (failure != null) fail(`${label} errored: ${failure.title} - ${failure.detail}`);
  }
  fail(`${label} never answered within the budget (${elapsed()})`);
};

const memories = async (agentId) => {
  const rows = await call("getAgentMemories", { id: agentId });
  return Array.isArray(rows) ? rows : [];
};

const previous = await readSetting(SETTING);
let probe = null;
let failure = null;
let restarted = false;
try {
  // (a) What the host reported about this gate when it started, and whether it armed.
  const gateLine = await lastLogLine("[sand][gates]");
  const gates = (() => { try { return JSON.parse(gateLine.slice(gateLine.indexOf("{"))); } catch { return {}; } })();
  const row = gates.sand_memory_dreaming;
  if (row == null) fail("the host's [sand][gates] line has no sand_memory_dreaming row");
  console.log(`gate table at host start: sand_memory_dreaming = ${JSON.stringify(row)}`
    + ` (${SETTING} was ${previous === undefined ? "unset" : JSON.stringify(previous)} then)`);

  // (b) Arming is a start-time decision, so a switch flipped now only counts after a restart.
  await writeSetting(SETTING, "1");
  let armed = (await lastLogLine("[sand][memory] synthesis")).includes("armed");
  if (!armed) {
    console.log(`the running host did not arm synthesis; restarting ${BOX} with ${SETTING}=1 (this box is shared)`);
    await docker(["restart", BOX]);
    restarted = true;
    const by = Date.now() + Math.max(0, Math.min(RESTART_TIMEOUT_MS, remaining()));
    while (Date.now() < by) {
      await sleep(4000);
      const up = await call("getHostStatus").then(() => true).catch(() => false);
      if (up) break;
    }
    armed = (await lastLogLine("[sand][memory] synthesis")).includes("armed");
  }
  const armLine = await lastLogLine("[sand][memory] synthesis");
  console.log(`arming line: ${armLine || "(none)"}`);
  if (!armed) fail(`the host never armed memory synthesis with ${SETTING}=1: ${armLine || "no [sand][memory] line at all"}`);
  pass(`${SETTING}=1 arms synthesis at host start with no Cursor login`);

  // (c) A fresh agent starts with nothing remembered; anything else and the rest proves nothing.
  probe = await call("createAgent", { name: `probe-memory-${Math.random().toString(36).slice(2, 8)}`, description: "", origin: "user", isKickstartRequested: false });
  probe = probe?.agent ?? probe;
  if (probe?.id == null) fail("createAgent returned no agent");
  console.log(`probe agent: ${probe.id}`);
  await call("openAgent", { id: probe.id }).catch(() => {});
  const initial = await memories(probe.id);
  if (initial.length !== 0) fail(`the fresh probe already holds ${initial.length} memories`);
  pass("a fresh agent holds no memories");

  // (d) One turn stating durable facts, conversationally. Not "remember this": the system prompt
  // tells the agent it can write memory itself with update_state, and an agent that does so writes
  // an EXPLICIT row that looks exactly like a synthesized one from the gateway. This gate is about
  // synthesis, so the turn has to give it no reason to reach for the tool.
  const from = await hostLogLines();
  await turn(
    probe.id,
    `Quick bit of context, no action needed. My office printer is called ${FACT_PRINTER}, and my desk phone extension is ${FACT_EXTENSION}. Just reply: noted.`,
    "turn 1",
  );

  // (e) The trigger is turn settlement itself: recordTurn debounces, then proposes and verifies
  // through the routed provider. Nothing here is called by hand.
  let rows = [];
  let synthesisLines = [];
  const synthesisBy = deadlineFor(SYNTHESIS_TIMEOUT_MS);
  while (Date.now() < synthesisBy) {
    rows = await memories(probe.id);
    synthesisLines = await logLinesSince(from, "[sand][memory]");
    if (rows.length > 0 && synthesisLines.some((line) => !line.includes("[sand][memory] turn "))) break;
    await sleep(4000);
  }
  if (rows.length === 0) {
    fail(`no memory was written within the budget (${elapsed()}). Host log said:\n  `
      + (synthesisLines.slice(-6).join("\n  ") || "(no [sand][memory] line at all: synthesis never ran)"));
  }
  console.log(`synthesis said:\n  ${synthesisLines.slice(-4).join("\n  ") || "(nothing)"}`);

  // The settle-time line, which is what says the turn was handed to memory at all. Before this
  // wave the production turn shell was built with no memory store: shouldRemember was false on
  // every turn and nothing downstream could ever run, armed or not.
  const settle = synthesisLines
    .filter((line) => line.includes("[sand][memory] turn "))
    .map((line) => { try { return JSON.parse(line.slice(line.indexOf("{"))); } catch { return null; } })
    .filter((event) => event?.conversationId === probe.id);
  // The last line for the conversation can belong to the hidden verification turn synthesis runs
  // after it commits (nothing to remember there, by design). Judge the last visible turn.
  const handed = settle.filter((event) => event.hidden !== true).at(-1) ?? settle.at(-1);
  if (handed == null) fail("no [sand][memory] turn line for the probe; the turn never reached settlement");
  console.log(`settle: ${JSON.stringify(handed)}`);
  if (handed.hasStore !== true) fail("the settled turn carried no memory store: the turn shell was built without one");
  if (handed.hasEvidenceHook !== true) fail("the memory store offered no recordMemoryEvidence hook: synthesis is not armed for this store");
  if (handed.shouldRemember !== true) fail(`the settled turn was not handed to memory: ${JSON.stringify(handed)}`);

  const memoryDir = `/home/box/sand-data/agents/${probe.id}/memory`;
  console.log(`memories after turn 1 (${elapsed()}):\n  `
    + rows.map((memory) => `${memory.kind} ${memory.id} ${JSON.stringify(memory.content)}`).join("\n  "));
  const files = (await sh(`find /home/box/sand-data/agents/${probe.id}/memory -name '*.md' 2>/dev/null || true`)).split("\n").filter(Boolean);
  if (files.length === 0) fail("getAgentMemories returned rows but no markdown file exists under the agent's memory folder");

  // Who wrote it. FileMemoryStore stamps every fact with its origin under .dreaming/, and the
  // marker file is named for the same id the gateway lists, so the two can be matched exactly. A
  // row the AGENT wrote with update_state is stamped explicit and proves nothing about synthesis:
  // without this check a gate passes on the agent doing memory's job by hand.
  const markers = async (origin) => (await sh(`ls -1 ${memoryDir}/.dreaming/${origin} 2>/dev/null || true`))
    .split("\n").map((name) => name.replace(/\.memory$/, "")).filter(Boolean);
  const synthesized = await markers("synthesized");
  const explicit = await markers("explicit");
  console.log(`origins: synthesized ${JSON.stringify(synthesized)}, explicit ${JSON.stringify(explicit)}`);
  const bySynthesis = rows.filter((memory) => synthesized.includes(memory.id));
  if (bySynthesis.length === 0) {
    fail(explicit.length > 0
      ? "every row was written explicitly by the agent's own update_state tool, not by synthesis"
      : "no row carries a synthesized origin marker");
  }
  // And the run has to have said so. Synthesis outcomes used to go only to structured telemetry,
  // which leaves the box, so a failed or rejected pass was indistinguishable from silence.
  const committed = synthesisLines
    .filter((line) => !line.includes("[sand][memory] turn "))
    .map((line) => { try { return JSON.parse(line.slice(line.indexOf("{"))); } catch { return null; } })
    .filter((event) => event?.agentId === probe.id);
  if (!committed.some((event) => event.outcome === "committed")) {
    fail(`no [sand][memory] line reports a committed synthesis for the probe; the log said:\n  `
      + (synthesisLines.slice(-6).join("\n  ") || "(nothing)"));
  }
  pass(`synthesis wrote durable memory to the box: ${bySynthesis.length} synthesized row(s) across ${files.join(", ")}`);

  // (f) The point of writing it: the NEXT turn's prompt carries the fact.
  // Turn 2 does double duty: it asks what only memory can answer, and it drops one more durable
  // fact of a different kind (time-bound, so it belongs in the log rather than the profile). The
  // second fact is what gives the forget step below a row to leave behind, so clear is exercised
  // against a populated store rather than an emptied one.
  await turn(
    probe.id,
    `In one short sentence, what is my office printer called and where is it? Also, for context, I fly to ${TRIP_CITY} next Tuesday.`,
    "turn 2",
  );
  const report = await promptReport(probe.id);
  if (report == null) fail(`no prompt section report for the probe; SAND_TOOL_TRACE must be on for this gate`);
  console.log(`assembled system prompt: ${report.length} chars; sections present: `
    + `${Object.entries(report.sections ?? {}).filter(([, has]) => has === true).map(([name]) => name).join(", ")}`
    + `; memoryFacts ${report.memoryFacts}`);
  if (report.sections?.memory !== true) fail("the assembled prompt carries no memory section");
  // sections.memory is true for any agent with a memory folder, facts or not, so the count is what
  // actually says a remembered fact reached the model.
  if (report.memoryFacts == null) fail("the prompt report has no memoryFacts; this host predates the count");
  if (!(report.memoryFacts >= 1)) fail(`the memory section carried ${report.memoryFacts} fact lines: the written memory never reached the prompt`);
  pass(`the written memory reached the assembled prompt (${report.memoryFacts} fact line(s) in the memory section)`);

  // (g) GW-06: forget one row, then clear the rest. Wait for turn 2's synthesis pass first so
  // there is more than one row to tell apart; a single row still proves forget, it just leaves
  // clear nothing to take away.
  const secondBy = deadlineFor(SYNTHESIS_TIMEOUT_MS);
  while (Date.now() < secondBy && (await memories(probe.id)).length < 2) await sleep(4000);
  const before = await memories(probe.id);
  console.log(`memories before forget (${elapsed()}):\n  `
    + before.map((memory) => `${memory.kind} ${memory.id} ${JSON.stringify(memory.content)}`).join("\n  "));
  const target = before[0];
  const forgot = await call("deleteAgentMemory", { id: probe.id, memoryId: target.id });
  const afterForget = await memories(probe.id);
  if (afterForget.some((memory) => memory.id === target.id)) {
    fail(`deleteAgentMemory returned ${JSON.stringify(forgot)} but ${target.id} is still listed`);
  }
  if (afterForget.length !== before.length - 1) {
    fail(`forget removed ${before.length - afterForget.length} rows, expected exactly 1`);
  }
  pass(`forget removed exactly the named row (${target.id}, ${before.length} -> ${afterForget.length})`);

  await call("clearAgentMemories", { id: probe.id });
  const afterClear = await memories(probe.id);
  if (afterClear.length !== 0) fail(`clear left ${afterClear.length} rows: ${JSON.stringify(afterClear).slice(0, 300)}`);
  const leftover = (await sh(`grep -l '^- (' $(find /home/box/sand-data/agents/${probe.id}/memory -name '*.md' 2>/dev/null) 2>/dev/null || true`)).trim();
  if (leftover.length > 0) fail(`clear emptied the listing but left fact lines on disk in ${leftover}`);
  pass(afterForget.length > 0
    ? `clear emptied a populated store (${afterForget.length} -> 0) and left no fact line on disk`
    : "clear ran against an already-empty store and left no fact line on disk");

  console.log(`SUMMARY: durable memory works with ${SETTING}=1 and no Cursor login. A turn settled,`
    + ` synthesis ran through the routed provider, wrote ${rows.length} row(s) to the agent's own`
    + ` markdown on the box, the next turn's prompt carried ${report.memoryFacts} fact line(s), and`
    + ` forget and clear both took rows away (${elapsed()}).`);
} catch (error) {
  failure = error;
  console.log(`FAIL - ${error.message}`);
} finally {
  if (probe?.id != null) {
    const idleBy = Date.now() + PROBE_IDLE_TIMEOUT_MS;
    while (Date.now() < idleBy) {
      if ((await call("listAgents").catch(() => [])).find((agent) => agent.id === probe.id)?.isRunning !== true) break;
      await sleep(4000);
    }
    await call("deleteAgents", { ids: [probe.id] }).catch(() => call("deleteAgent", { id: probe.id }).catch(() => {}));
    await sh(`rm -f /home/box/sand-data/sand-system-prompt-${probe.id}.json`).catch(() => {});
    await sh(`rm -rf /home/box/sand-data/agents/${probe.id}`).catch(() => {});
  }
  if (!KEEP_SETTING) {
    await writeSetting(SETTING, previous ?? null).catch(() => {});
    console.log(`${SETTING} restored to ${previous === undefined ? "unset" : JSON.stringify(previous)}`
      + (restarted ? " (the box was restarted by this run; it stays armed until the next restart)" : ""));
  } else {
    console.log(`${SETTING} left at "1" for this box`);
  }
}
process.exit(failure == null ? 0 : 1);
