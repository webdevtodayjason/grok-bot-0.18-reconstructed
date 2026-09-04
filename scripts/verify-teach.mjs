// Teach by demonstration, end to end, on a box that has never logged in to Cursor.
//
// Three things had to be true before this could pass, and none of them were:
//   1. The recorder read the Statsig gate `sand_teach_by_demonstration` directly. Gates default
//      false and only bootstrap with a Cursor login, so every startTeachRecording was refused.
//      There is now a host setting, SAND_TEACH, read live on each call the way SAND_BROWSER_USE is.
//   2. Stop-with-save calls ensureManagedSkill("learn-from-demonstration"), and managed skills
//      come from Cursor's dashboard. With no login the cache stayed empty, so a saved recording
//      died at "learning workflow is unavailable". The two real skills are baked into the bundle.
//   3. Nothing reported whether the dispatched learning turn actually carried the skill's recipe
//      and the recording's queue scope. It does -- expandWorkflowReferences has always appended
//      "Teach recording queue scope:" for this skill -- but the only surface that could show it
//      was a [sand][workflow] trace line, added behind SAND_TOOL_TRACE for this gate. That line
//      now reports inlinedChars as well, because the recipe used to arrive cut at 8000 characters
//      with its last two sections missing and nothing anywhere said so.
//
// Every step here is a hard failure, the agent's claim of the queue file included: a run that
// records and dispatches but leaves the work unclaimed has not closed the loop, and an exit code
// that cannot tell those apart is not worth reading.
//
// Integration check, not a unit test: needs the box up, a provider configured, and a real turn.
//
//   node scripts/verify-teach.mjs                 runs and puts SAND_TEACH back as it found it
//   node scripts/verify-teach.mjs --keep-setting  leaves SAND_TEACH="1" on for this box
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const SESSIONS = "/workspace/teach-sessions";
const QUEUES = `${SESSIONS}/queues`;
const KEEP_SETTING = process.argv.includes("--keep-setting");
// Budgeted against the 300s warden ceiling, worst case, including the cleanup in the finally:
// window 45 + expansion 45 + claim 120 + idle wait 25 leaves room for the two real turns.
const CLAIM_TIMEOUT_MS = 120_000;
const EXPANSION_TIMEOUT_MS = 45_000;
const WINDOW_TIMEOUT_MS = 45_000;
const PROBE_IDLE_TIMEOUT_MS = 25_000;

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

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));
const sh = (command) => docker(["exec", BOX, "sh", "-c", command]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throw rather than exit: the finally below still has to put the operator's switches back and
// delete the probe agent, and process.exit skips finally blocks.
class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
const pass = (message) => console.log(`PASS - ${message}`);

// Same host settings file the other gates flip, same 0600 the host wrote it with.
//
// readSettingsFile (source/host/sand-box-setting.ts) accepts either a flat object or
// { settings: { ... } } and PREFERS the nested one when it is there, so both helpers have to
// resolve the same container the reader picks. Only touching the top level meant that on an
// operator's nested file the write landed on a key the resolver never consults: SAND_TEACH would
// not move, this gate would fail as if the product were broken, and the restore would then delete
// a key it had invented while the real switch was never touched.
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
const jsonLinesSince = async (from, tag) => {
  const out = await sh(`tail -n +${from + 1} /tmp/sand-host.log | grep -F '${tag} ' || true`);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf(`${tag} `);
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + tag.length + 1))]; } catch { return []; }
  });
};

// queueScope in teach-recording-service.ts: sha256 of the agent id, hex.
const queueScope = (agentId) => createHash("sha256").update(agentId).digest("hex");
const sessionDirs = async () =>
  (await sh(`ls -1d ${SESSIONS}/teach-* 2>/dev/null || true`)).split("\n").filter(Boolean);
const pendingFiles = async (scope) =>
  (await sh(`ls -1 ${QUEUES}/${scope}/pending/*.json 2>/dev/null || true`)).split("\n").filter(Boolean);
const claimedFiles = async (scope) =>
  (await sh(`ls -1 ${QUEUES}/${scope}/claimed/*.json 2>/dev/null || true`)).split("\n").filter(Boolean);

const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

const previousTeach = await readSetting("SAND_TEACH");
const previousTrace = await readSetting("SAND_TOOL_TRACE");
let probe = null;
let failure = null;
const createdDirs = [];
// The workflow library on this box is GLOBAL (workflow-store.ts GlobalWorkflowLibrary; per-agent
// state is only the enablement), so every skill the learning turn writes is visible to every
// production agent and outlives the probe that produced it. Measured: one save-path run left
// three "Flag unassigned tickets" workflows behind that had to be deleted by hand. Snapshot the
// library before the turn and take out whatever the run added.
let libraryBefore = null;
const libraryIds = async (agentId) =>
  ((await call("getAgentWorkflows", { id: agentId }).catch(() => [])) ?? [])
    .filter((workflow) => workflow.source !== "automation")
    .map((workflow) => workflow.id);
try {
  // (a) What the host reported about this gate when it started.
  const gateLine = (await sh("grep -F '[sand][gates]' /tmp/sand-host.log | tail -1")).trim();
  const gates = (() => { try { return JSON.parse(gateLine.slice(gateLine.indexOf("{"))); } catch { return {}; } })();
  const teachRow = gates.sand_teach_by_demonstration;
  if (teachRow == null) fail("the host's [sand][gates] line has no sand_teach_by_demonstration row");
  console.log(`gate table at host start: sand_teach_by_demonstration = ${JSON.stringify(teachRow)}`
    + ` (SAND_TEACH was ${previousTeach === undefined ? "unset" : JSON.stringify(previousTeach)} then)`);

  // The seeds are what make step (e) possible at all; say so before spending a turn.
  const cachedSkills = JSON.parse(await sh("cat /home/box/sand-data/managed-skills/cache.json 2>/dev/null || echo '{}'"));
  const learn = (cachedSkills.skills ?? []).find((skill) => skill.id === "learn-from-demonstration");
  if (learn == null) fail("the managed-skills cache holds no learn-from-demonstration; the seeds never reached the box");
  console.log(`managed skills on the box: ${(cachedSkills.skills ?? []).map((s) => s.id).join(", ")}`);
  // cache.json is only half of it. The agent is handed the skill by file path, so check the file
  // the way the agent would: a cache row whose SKILL.md is gone used to survive every restart.
  const skillFile = "/home/box/sand-data/managed-skills/skills/learn-from-demonstration/SKILL.md";
  const skillFileRaw = await sh(`cat ${skillFile} 2>/dev/null || true`);
  if (!skillFileRaw.startsWith("---\n")) fail(`${skillFile} is missing or is not a skill file`);
  // Length alone said nothing: a 60-character cache row against a 10k file passed that check while
  // the prompt inlined one recipe and the agent read another. Compare the bodies instead.
  const close = skillFileRaw.indexOf("\n---\n");
  const fileBody = close < 0 ? "" : skillFileRaw.slice(close + 5).replace(/\n+$/, "");
  if (fileBody !== learn.body.trim()) {
    fail(`${skillFile} and cache.json hold different recipes: ${fileBody.length} chars on disk against ${learn.body.trim().length} cached`);
  }
  pass(`the learning skill exists with no Cursor login and both copies say the same thing (${learn.body.length} chars in cache.json, the same ${fileBody.length} in SKILL.md, heading ${JSON.stringify(learn.body.split("\n", 1)[0])})`);

  // (b) With the switch off the recorder must refuse, and say why.
  await writeSetting("SAND_TEACH", "0");
  probe = await call("createAgent", { name: `probe-teach-${Math.random().toString(36).slice(2, 8)}`, description: "", origin: "user", isKickstartRequested: false });
  probe = probe?.agent ?? probe;
  if (probe?.id == null) fail("createAgent returned no agent");
  console.log(`probe agent: ${probe.id}`);
  const scope = queueScope(probe.id);
  console.log(`queue scope: ${scope}`);
  libraryBefore = await libraryIds(probe.id);
  console.log(`workflow library before the run (${libraryBefore.length}): ${libraryBefore.join(", ") || "(empty)"}`);

  let refusal = null;
  try { await call("startTeachRecording", { agentId: probe.id }); } catch (error) { refusal = error.message; }
  if (refusal == null) fail("startTeachRecording succeeded with SAND_TEACH=0; the switch does not gate anything");
  console.log(`refusal with SAND_TEACH=0: ${refusal.slice(0, 200)}`);
  if (!/feature gate is off/i.test(refusal)) fail(`the refusal does not name the gate: ${refusal.slice(0, 200)}`);
  pass("SAND_TEACH=0 refuses the recording and names the gate");

  // (c) Flip the switch on a running host -- no restart -- and record for real.
  await writeSetting("SAND_TEACH", "1");
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", "1");

  // The recorder refuses an agent without its own X display (fork window index >= 3); the
  // websockify token in the vnc url IS that display number.
  let display = null;
  const windowBy = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < windowBy) {
    const status = await call("ensureForeverBox", { id: probe.id }).catch(() => null);
    const url = String(status?.vncUrl ?? "");
    const parsed = Number(/token%3D(\d+)/i.exec(url)?.[1] ?? /token=(\d+)/i.exec(url)?.[1] ?? NaN);
    if (Number.isInteger(parsed) && parsed >= 3) { display = parsed; break; }
    await sleep(3000);
  }
  if (display == null) fail(`the probe never got its own display within ${WINDOW_TIMEOUT_MS / 1000}s; the recorder requires a private monitor`);
  console.log(`probe display: :${display} (${elapsed()})`);

  const beforeStart = new Set(await sessionDirs());
  const started = await call("startTeachRecording", { agentId: probe.id });
  if (started?.state !== "recording") fail(`startTeachRecording returned state ${JSON.stringify(started?.state)}`);
  if (started?.agentId !== probe.id) fail(`the recording is attributed to ${JSON.stringify(started?.agentId)}, not the probe`);
  const polled = await call("getTeachRecordingStatus");
  if (polled?.state !== "recording" || polled?.agentId !== probe.id) fail(`getTeachRecordingStatus disagrees: ${JSON.stringify(polled)}`);
  const sessionDir = (await sessionDirs()).find((dir) => !beforeStart.has(dir));
  if (sessionDir == null) fail("no new session directory appeared under /workspace/teach-sessions");
  const ffmpeg = (await sh(`for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -F ${JSON.stringify(`${sessionDir}/demo.mp4`)} && echo " <- $p"; done || true`)).trim();
  if (!ffmpeg.includes(`${sessionDir}/demo.mp4`)) fail(`no ffmpeg process owns ${sessionDir}/demo.mp4`);
  createdDirs.push(sessionDir);
  console.log(`session dir: ${sessionDir}`);
  console.log(`ffmpeg: ${ffmpeg.replace(/\s+/g, " ").slice(0, 220)}`);
  pass(`SAND_TEACH=1 records on a live host with no restart (state recording, ffmpeg owns demo.mp4)`);

  // (d) Discard leaves nothing behind.
  const discarded = await call("stopTeachRecording", { agentId: probe.id, save: false });
  if (discarded?.state !== "idle") fail(`stopTeachRecording{save:false} returned state ${JSON.stringify(discarded?.state)}`);
  const leftovers = (await sh(`ls -1 ${sessionDir}/demo.mp4 2>/dev/null || true`)).trim();
  if (leftovers.length > 0) fail(`the discarded session still holds ${leftovers}`);
  const strayPending = await pendingFiles(scope);
  if (strayPending.length > 0) fail(`a discarded recording left ${strayPending.length} queue file(s): ${strayPending.join(", ")}`);
  console.log(`after discard: session dir ${(await sessionDirs()).includes(sessionDir) ? "still present but empty of video" : "removed"}, 0 pending queue files`);
  pass("a discarded recording leaves no video and no queue entry");

  // (e) Save: queue file, learning turn, and the agent claiming the work.
  const from = await hostLogLines();
  const beforeSave = new Set(await sessionDirs());
  const saveStart = await call("startTeachRecording", { agentId: probe.id });
  if (saveStart?.state !== "recording") fail(`the second startTeachRecording returned ${JSON.stringify(saveStart?.state)}`);
  await sleep(6000);
  const saved = await call("stopTeachRecording", { agentId: probe.id, save: true });
  if (saved?.state !== "idle") fail(`stopTeachRecording{save:true} returned state ${JSON.stringify(saved?.state)}`);
  const savedDir = (await sessionDirs()).find((dir) => !beforeSave.has(dir));
  if (savedDir == null) fail("the saved recording produced no session directory");
  createdDirs.push(savedDir);
  const listing = (await sh(`ls -l ${savedDir} 2>/dev/null || true`)).trim();
  console.log(`saved session ${savedDir}:\n${listing}`);
  const videoBytes = Number.parseInt((await sh(`stat -c %s ${savedDir}/demo.mp4 2>/dev/null || echo 0`)).trim(), 10);
  if (!(videoBytes > 0)) fail(`${savedDir}/demo.mp4 is missing or empty (${videoBytes} bytes)`);
  const sessionMeta = (await sh(`cat ${savedDir}/session.json 2>/dev/null || true`)).trim();
  if (sessionMeta.length === 0) fail(`${savedDir}/session.json was never written`);
  pass(`the saved recording holds session.json and a ${videoBytes}-byte demo.mp4`);

  const queued = await pendingFiles(scope);
  const claimedAlready = await claimedFiles(scope);
  if (queued.length + claimedAlready.length !== 1) {
    fail(`expected exactly one queue entry for this scope, found ${queued.length} pending and ${claimedAlready.length} claimed`);
  }
  const queueEntry = JSON.parse(await sh(`cat ${(queued[0] ?? claimedAlready[0])}`));
  if (queueEntry.agentId !== probe.id || !/^[0-9a-f]{64}$/.test(String(queueEntry.signature ?? ""))) {
    fail(`the queue entry is not a signed record for this agent: ${JSON.stringify(queueEntry).slice(0, 200)}`);
  }
  pass(`exactly one signed queue entry under scope ${scope.slice(0, 12)} (${queued[0] ?? claimedAlready[0]})`);

  // The learning turn: did the dispatched prompt actually carry the recipe and the scope?
  let expansion = null;
  const expansionBy = Date.now() + EXPANSION_TIMEOUT_MS;
  while (Date.now() < expansionBy) {
    expansion = (await jsonLinesSince(from, "[sand][workflow]"))
      .find((line) => line.conversationId === probe.id && line.id === "learn-from-demonstration");
    if (expansion != null) break;
    await sleep(3000);
  }
  if (expansion == null) fail("no [sand][workflow] line: the learning turn never expanded the skill into its prompt");
  console.log(`learning prompt: ${JSON.stringify(expansion)}`);
  if (!/learn from a demonstration/i.test(String(expansion.bodyHead)) && !/learn-from-demonstration/.test(String(expansion.name))) {
    fail(`the expanded block does not carry the skill: bodyHead ${JSON.stringify(expansion.bodyHead)}`);
  }
  if (expansion.teachQueueScope !== scope) fail(`the prompt carries queue scope ${JSON.stringify(expansion.teachQueueScope)}, expected ${scope}`);
  // The whole recipe or nothing: the tail is where the skill says what to write and how to
  // release the claim, so a prompt missing it produces a run that looks alive and does neither.
  if (expansion.inlinedChars == null) fail("the [sand][workflow] line reports no inlinedChars; this host predates the truncation fix");
  if (expansion.isTruncated !== false || expansion.inlinedChars !== expansion.bodyChars) {
    fail(`the recipe reached the model cut: ${expansion.inlinedChars} of ${expansion.bodyChars} chars`);
  }
  pass(`the learning turn's prompt carried the whole recipe (${expansion.inlinedChars} of ${expansion.bodyChars} chars) and the queue scope`);

  // The agent's own work: it claims the queue file before it can do anything with the video.
  let claimed = [];
  const claimBy = Date.now() + CLAIM_TIMEOUT_MS;
  while (Date.now() < claimBy) {
    claimed = await claimedFiles(scope);
    if (claimed.length > 0) break;
    await sleep(5000);
  }
  const transcript = await call("getAgentTranscript", { id: probe.id }).catch(() => []);
  const said = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry.kind === "message").slice(-4)
    .map((entry) => `  ${entry.role ?? "?"}: ${String(entry.message?.content ?? entry.content ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
  console.log(`probe's last messages (${elapsed()}):\n${said.join("\n") || "  (nothing said yet)"}`);
  if (claimed.length === 0) fail(`the agent never claimed the queue file within ${CLAIM_TIMEOUT_MS / 1000}s; the loop does not close`);
  pass(`the agent claimed the recording: ${claimed.join(", ")}`);

  console.log(`SUMMARY: teach recording works with SAND_TEACH=1 and no Cursor login. Refused when off, recorded, discarded clean, saved with a signed queue entry, dispatched a learning turn carrying the whole recipe and scope ${scope.slice(0, 12)}, and the agent claimed the work (${elapsed()}).`);
} catch (error) {
  failure = error;
  console.log(`FAIL - ${error.message}`);
} finally {
  // Stop anything still rolling before the probe goes away, or ffmpeg keeps writing into a
  // session directory nobody owns.
  if (probe?.id != null) {
    await call("stopTeachRecording", { agentId: probe.id, save: false }).catch(() => {});
    const idleBy = Date.now() + PROBE_IDLE_TIMEOUT_MS;
    while (Date.now() < idleBy) {
      if ((await call("listAgents").catch(() => [])).find((a) => a.id === probe.id)?.isRunning !== true) break;
      await sleep(4000);
    }
    await sh(`rm -rf ${QUEUES}/${queueScope(probe.id)}`).catch(() => {});
    for (const dir of createdDirs) await sh(`rm -rf ${dir}`).catch(() => {});
    await call("deleteAgents", { ids: [probe.id] }).catch(() => call("deleteAgent", { id: probe.id }).catch(() => {}));
    await sh(`rm -f /home/box/sand-data/sand-system-prompt-${probe.id}.json`).catch(() => {});
    // The library is read and written through an agent id but the rows are shared, so the sweep
    // works through a surviving agent. Twice, a few seconds apart: the learning turn can write one
    // last workflow while the delete above is landing, and a skill left in the shared library is a
    // production agent's problem, not this gate's.
    const survivor = (await call("listAgents").catch(() => [])).find((agent) => agent.id !== probe.id)?.id ?? null;
    if (libraryBefore != null && survivor != null) {
      for (let pass = 0; pass < 2; pass += 1) {
        if (pass > 0) await sleep(5000);
        const added = (await libraryIds(survivor)).filter((id) => !libraryBefore.includes(id));
        for (const workflowId of added) {
          const gone = await call("deleteAgentWorkflow", { id: survivor, workflowId }).then(() => true).catch(() => false);
          console.log(`library sweep: ${gone ? "deleted" : "COULD NOT DELETE"} ${workflowId}`);
        }
      }
      const left = (await libraryIds(survivor)).filter((id) => !libraryBefore.includes(id));
      console.log(`workflow library after the sweep: ${left.length === 0 ? "back to what the run found" : `STILL HOLDS ${left.join(", ")}`}`);
    } else if (libraryBefore != null) {
      console.log("workflow library NOT swept: no surviving agent to read it through");
    }
  }
  if (KEEP_SETTING) {
    await writeSetting("SAND_TEACH", "1").catch(() => {});
    console.log("SAND_TEACH left at \"1\": teach recording stays on for this box.");
  } else {
    await writeSetting("SAND_TEACH", previousTeach).catch(() => {});
  }
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", previousTrace).catch(() => {});
}
// The elapsed() readings above stop at the claim; cleanup is the rest of the wall clock, and the
// wall clock is what has to fit the warden's ceiling.
console.log(`wall clock including cleanup: ${elapsed()}`);
process.exit(failure == null ? 0 : 1);
