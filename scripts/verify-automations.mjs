#!/usr/bin/env node
// The local clock, proved end to end: a routine nobody presses fires on its own schedule, is
// recorded as a schedule, and wakes its agent with the truth about why it is awake.
//
// Three things were wrong and none of them were visible from outside:
//   1. The tick fired through runAgentAutomationNow, which hardcodes trigger "manual". Every
//      scheduled run on this box was filed as a manual one, and the wake prompt told the agent
//      "the user pressed Run now on this standing order", which nobody had.
//   2. Each fire minted a fresh run id, so the slot it was serving left no trace. A routine that
//      came back after the box was down through its slot recorded a run stamped with the minute it
//      recovered, and the slot it was owed simply looked unfired. The run id is now derived from
//      the slot, which also makes a second fire for one slot land on the run that already exists.
//   3. A fire whose definition could not be read dropped out of runAgentAutomationNow in silence
//      while the tick logged "fired". The entry point reports what it did and the tick logs that.
//
// Two model turns, one per slot, on a probe agent this script creates and deletes. Needs
// SAND_TOOL_TRACE for the [sand][automation-wake] line, and puts it back as it found it.
//
//   node scripts/verify-automations.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
// The tick polls every 20s, so a slot is served within about that of becoming due; a turn on the
// probe's one-word prompt has run in seconds. Two slots a minute apart plus the waits below sit
// inside the 300s warden ceiling with room for the cleanup in the finally.
const SLOT_TIMEOUT_MS = 100_000;

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
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));
const sh = (command) => docker(["exec", BOX, "sh", "-c", command]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
const pass = (message) => console.log(`PASS - ${message}`);
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

// The run id derivation, taken from the shipped source rather than restated here: a gate that
// carries its own copy of the rule cannot catch the rule changing.
async function loadRunUuid() {
  const source = await readFile(new URL("../source/host/automations/automation-id.ts", import.meta.url), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.localScheduleRunUuid;
}
const localScheduleRunUuid = await loadRunUuid();

const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const nested = parsed.settings;
    return (nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed)[name];
  } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null ? `delete c[${JSON.stringify(name)}];` : `c[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + `const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};
const hostLogLines = async () => Number.parseInt((await sh("wc -l < /tmp/sand-host.log")).trim(), 10);
const wakeLinesSince = async (from) => {
  const out = await sh(`tail -n +${from + 1} /tmp/sand-host.log | grep -F '[sand][automation-wake] ' || true`);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf("[sand][automation-wake] ");
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + "[sand][automation-wake] ".length))]; } catch { return []; }
  });
};

const AUTOMATION_ID_HINT = "verify-automations-probe";
const runsOf = async (agentId, automationId) =>
  ((await call("getAgentAutomations", { id: agentId })).find((entry) => entry.id === automationId)?.runs ?? []);
const waitForRun = async (agentId, automationId, runUuid, label) => {
  const deadline = Date.now() + SLOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = (await runsOf(agentId, automationId)).find((entry) => entry.id === runUuid);
    if (run != null) return run;
    await sleep(3000);
  }
  const seen = (await runsOf(agentId, automationId)).map((entry) => `${entry.id}(${entry.trigger})`);
  fail(`${label}: no run with the slot's own id after ${Math.round(SLOT_TIMEOUT_MS / 1000)}s. Runs on the routine: ${seen.length ? seen.join(", ") : "none"}`);
};
const waitForAnotherRun = async (agentId, automationId, known, label) => {
  const deadline = Date.now() + SLOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = (await runsOf(agentId, automationId)).find((entry) => !known.has(entry.id));
    if (run != null) return run;
    await sleep(3000);
  }
  fail(`${label}: no second run after ${Math.round(SLOT_TIMEOUT_MS / 1000)}s`);
};
// Which minute the second run served is not something this script gets to assume: the first turn
// holds the agent, the tick skips a busy agent, and a turn that ran long pushes the next served
// slot past the minute after the first. So the slot is recovered from the id instead. A run id
// that matches no minute in the window is the finding this gate exists for, back again.
const slotBehind = (runUuid, agentId, localId, fromMs, toMs) => {
  for (let slot = Math.ceil(fromMs / 60_000) * 60_000; slot <= toMs; slot += 60_000)
    if (localScheduleRunUuid({ agentId, localId, slotMs: slot }) === runUuid) return slot;
  return null;
};

const previousTrace = await readSetting("SAND_TOOL_TRACE");
let probeId = null;
let automationId = null;
let failed = null;
try {
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", "1");
  const logFrom = await hostLogLines();

  const made = await call("createAgent", { name: `probe-u2-automations-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
  probeId = (made?.agent ?? made)?.id ?? null;
  if (probeId == null) fail("createAgent returned no agent");

  // Plant the routine with room left in the minute: created at :59 the slot would be due before
  // this script has read which slot it is. Ten seconds is all the reading needs, and waiting for a
  // wider window is wall clock this gate has to fit inside the warden's ceiling.
  while (new Date().getUTCSeconds() > 50) await sleep(1000);
  const created = await call("createAgentAutomation", {
    id: probeId,
    spec: { name: AUTOMATION_ID_HINT, prompt: "Reply with the single word TICK and nothing else.", isEnabled: true, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  const planted = (Array.isArray(created) ? created : [created]).find((entry) => entry?.name === AUTOMATION_ID_HINT) ?? (Array.isArray(created) ? created[0] : created);
  automationId = planted?.id ?? null;
  if (automationId == null) fail(`createAgentAutomation returned no routine: ${JSON.stringify(created).slice(0, 200)}`);
  const slotOne = (await call("getAgentAutomations", { id: probeId })).find((entry) => entry.id === automationId)?.nextRunAt ?? null;
  if (slotOne == null) fail("the host derived no nextRunAt for an every-minute routine");
  const uuidOne = localScheduleRunUuid({ agentId: probeId, localId: automationId, slotMs: slotOne });
  pass(`a routine nobody pressed is planted on ${probeId}, first slot ${new Date(slotOne).toISOString()} (${elapsed()})`);

  const runOne = await waitForRun(probeId, automationId, uuidOne, "first slot");
  pass(`the box fired it with no manual trigger and recorded the run under the slot's own id ${uuidOne} (${elapsed()})`);
  if (runOne.trigger !== "schedule") fail(`the run is filed as "${runOne.trigger}", not "schedule" - this is the finding, unfixed`);
  pass(`and the run is filed as a schedule, not a manual run`);

  const wakes = (await wakeLinesSince(logFrom)).filter((line) => line.conversationId === probeId);
  const wakeOne = wakes.find((line) => line.runUuid === uuidOne);
  if (wakeOne == null) fail(`no [sand][automation-wake] line for ${uuidOne}; saw ${wakes.length} wake line(s) for the probe`);
  if (wakeOne.trigger !== "schedule") fail(`the agent was woken with trigger "${wakeOne.trigger}"`);
  if (/run on demand/.test(wakeOne.opening) || !/is due/.test(wakeOne.opening)) fail(`the prompt the agent received does not name the schedule: ${JSON.stringify(wakeOne.opening)}`);
  if (wakeOne.scheduledForMs !== slotOne) fail(`the fire carried scheduledForMs ${wakeOne.scheduledForMs}, not the slot ${slotOne}`);
  if (wakeOne.runId !== uuidOne) fail(`the run row opened for the wake is ${wakeOne.runId}, not the slot's id`);
  pass(`the prompt it woke on says the routine is due on its schedule, not that the user pressed Run now`);

  const runTwo = await waitForAnotherRun(probeId, automationId, new Set([uuidOne]), "second slot");
  const uuidTwo = runTwo.id;
  const slotTwo = slotBehind(uuidTwo, probeId, automationId, slotOne + 60_000, Date.now() + 60_000);
  if (slotTwo == null) fail(`the second run is ${uuidTwo}, which is not the id of any slot between ${new Date(slotOne + 60_000).toISOString()} and now: it was minted fresh, not derived from the slot it served`);
  pass(`the next slot ${new Date(slotTwo).toISOString()} fired as its own run ${uuidTwo} (${elapsed()})`);
  const all = await runsOf(probeId, automationId);
  const forOne = all.filter((entry) => entry.id === uuidOne).length;
  const forTwo = all.filter((entry) => entry.id === uuidTwo).length;
  if (forOne !== 1 || forTwo !== 1) fail(`a slot ran more than once: ${forOne} run(s) for slot one, ${forTwo} for slot two`);
  const strays = all.filter((entry) => entry.id !== uuidOne && entry.id !== uuidTwo);
  if (strays.length > 0) fail(`${strays.length} run(s) not derived from either slot: ${strays.map((entry) => `${entry.id}(${entry.trigger})`).join(", ")}`);
  if (all.some((entry) => entry.trigger !== "schedule")) fail(`a run is filed under a trigger other than schedule: ${all.map((entry) => entry.trigger).join(", ")}`);
  pass(`two slots, two runs, no duplicate for either and nothing else in the history (${elapsed()})`);
} catch (error) {
  failed = error;
} finally {
  if (probeId != null && automationId != null) await call("deleteAgentAutomation", { id: probeId, automationId }).catch(() => {});
  if (probeId != null) await call("deleteAgent", { id: probeId }).catch((error) => console.log(`  INFO  probe agent NOT deleted: ${error.message}`));
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", previousTrace ?? null).catch(() => {});
}
if (failed != null) {
  console.error(`FAIL - ${failed instanceof VerificationFailed ? failed.message : failed.stack ?? failed}`);
  process.exit(1);
}
console.log(`OK - the box runs its own schedule, files it as one, and says so to the agent (${elapsed()})`);
