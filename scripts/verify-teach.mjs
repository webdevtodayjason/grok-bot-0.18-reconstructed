// Teach by demonstration, end to end, on a box that has never logged in to Cursor.
//
// Four things had to be true before this could pass, and none of them were:
//   1. The recorder read the Statsig gate `sand_teach_by_demonstration` directly. Gates default
//      false and only bootstrap with a Cursor login, so every startTeachRecording was refused.
//      There is now a host setting, SAND_TEACH, read live on each call the way SAND_BROWSER_USE is.
//   2. Stop-with-save calls ensureManagedSkill("learn-from-demonstration"), and managed skills
//      come from Cursor's dashboard. With no login the cache stayed empty, so a saved recording
//      died at "learning workflow is unavailable". The two real skills are baked into the bundle.
//   3. The operator's note from the Learn dialog was not in that turn at all: the page sent it as
//      an ordinary message after the stop resolved, and the host dispatches the learning turn from
//      inside the stop, so the note always landed behind the turn it was meant to steer. It is an
//      argument of stopTeachRecording now, and this gate reads it back off the dispatched prompt.
//   4. Nothing reported whether the dispatched learning turn actually carried the skill's recipe
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
// window 45 + expansion 45 + claim 120 + skill 60 (+60 if the write has to be asked for) + idle
// wait 25 leaves room for the two real turns. The prompt wait shares its 45 with the expansion
// wait: both are waiting on the same dispatch, so whichever runs first is the one that spends the
// time.
const CLAIM_TIMEOUT_MS = 120_000;
// Step (f), the skill the turn writes. Measured runs reach the claim at ~73s and finish at ~103s,
// so 60s of waiting and, when the turn has not got to step 5 of the recipe yet, 60s more after it
// is asked outright keeps a real run near 220s.
const SKILL_TIMEOUT_MS = 60_000;
const SKILL_NUDGE_TIMEOUT_MS = 60_000;
const EXPANSION_TIMEOUT_MS = 45_000;
const WINDOW_TIMEOUT_MS = 45_000;
const PROBE_IDLE_TIMEOUT_MS = 25_000;
const PROMPT_TIMEOUT_MS = 45_000;
// What the Learn dialog's note field sends. The host has to put it in the prompt that starts the
// learning turn: it used to follow as a second message, dispatched after that turn had begun.
const OPERATOR_NOTE = "flag the unassigned tickets for Jason Brashear";

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

// The transcript comes back as a bare array from some hosts and as { entries } from others, and a
// reader that knows only one of those shapes reports an empty conversation instead of failing.
const transcriptEntries = async (agentId) => {
  const answer = await call("getAgentTranscript", { id: agentId }).catch(() => []);
  return Array.isArray(answer) ? answer : Array.isArray(answer?.entries) ? answer.entries : [];
};
const entryText = (entry) => {
  const value = entry?.message?.content ?? entry?.content;
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("") : "";
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
// A skill the learning turn writes is the probe's OWN (agent-state.ts stamps ownerAgentId on the
// create), so deleting the probe releases it. A global one -- anything this run adds without an
// owner -- outlives the probe and is every production agent's problem. Measured, before ownership
// existed: one save-path run left three "Flag unassigned tickets" workflows behind that had to be
// deleted by hand. Snapshot the library before the turn and take out whatever the run added.
let libraryBefore = null;
const libraryRows = async (agentId) =>
  ((await call("getAgentWorkflows", { id: agentId }).catch(() => [])) ?? [])
    .filter((workflow) => workflow.source !== "automation");
const libraryIds = async (agentId) => (await libraryRows(agentId)).map((workflow) => workflow.id);
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

  // The other half of the note story, and the only half no run on this box can measure: the
  // ten-minute cap fires inside the host, calls the same stop the Finish button calls, and has
  // nothing from the Learn dialog to hand it -- so a capped recording is saved and dispatched with
  // the operator note still sitting in the textarea. Waiting ten minutes to watch that happen does
  // not fit this gate, and the surface that can lie about it is the dialog, so the hint is read
  // here beside the note the run below proves the button does carry.
  const teachHtml = readFileSync(new URL("../ui/machine-room/index.html", import.meta.url), "utf8");
  const teachDialogAt = teachHtml.indexOf('id="teach-dialog"');
  if (teachDialogAt < 0) fail("ui/machine-room/index.html has no teach dialog to read the hint from");
  const teachDialog = teachHtml.slice(teachDialogAt, teachHtml.indexOf("</dialog>", teachDialogAt)).replace(/<!--[\s\S]*?-->/g, "");
  if (!/ten-minute cap[^<]*without this note/i.test(teachDialog)) {
    fail(`the Learn dialog does not say the ten-minute cap saves without the note: ${JSON.stringify(teachDialog.replace(/\s+/g, " ").slice(0, 400))}`);
  }
  pass("the Learn dialog says the note rides Finish recording and that a recording left to the ten-minute cap is saved without it");

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

  // The recorder refuses an agent without its own X display; fork windows start at 2
  // (SAND_BOX_FIRST_FORK_WINDOW_INDEX), and the websockify token in the vnc url IS that display
  // number. This once demanded 3 because Chief happened to hold :2 when it was written.
  let display = null;
  const windowBy = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < windowBy) {
    const status = await call("ensureForeverBox", { id: probe.id }).catch(() => null);
    const url = String(status?.vncUrl ?? "");
    const parsed = Number(/token%3D(\d+)/i.exec(url)?.[1] ?? /token=(\d+)/i.exec(url)?.[1] ?? NaN);
    if (Number.isInteger(parsed) && parsed >= 2) { display = parsed; break; }
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
  const saved = await call("stopTeachRecording", { agentId: probe.id, save: true, note: OPERATOR_NOTE });
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
  // The note is persisted here and nowhere else: the queue file is what the recipe claims and is
  // signed, so the note stays out of it, but a recording recovered after a restart has only this
  // file to read the operator's sentence back from.
  const parsedMeta = (() => { try { return JSON.parse(sessionMeta); } catch { return null; } })();
  if (parsedMeta == null) fail(`${savedDir}/session.json is not valid JSON: ${sessionMeta.slice(0, 200)}`);
  if (parsedMeta.note !== OPERATOR_NOTE) fail(`session.json holds note ${JSON.stringify(parsedMeta.note)}, expected the note the stop was given`);
  pass(`the saved recording holds session.json (carrying the operator's note), and a ${videoBytes}-byte demo.mp4`);

  const queued = await pendingFiles(scope);
  const claimedAlready = await claimedFiles(scope);
  if (queued.length + claimedAlready.length !== 1) {
    fail(`expected exactly one queue entry for this scope, found ${queued.length} pending and ${claimedAlready.length} claimed`);
  }
  const queueEntry = JSON.parse(await sh(`cat ${(queued[0] ?? claimedAlready[0])}`));
  if (queueEntry.agentId !== probe.id || !/^[0-9a-f]{64}$/.test(String(queueEntry.signature ?? ""))) {
    fail(`the queue entry is not a signed record for this agent: ${JSON.stringify(queueEntry).slice(0, 200)}`);
  }
  if (JSON.stringify(queueEntry).includes(OPERATOR_NOTE)) fail("the note is inside the signed queue entry; it is not part of what the recipe claims");
  pass(`exactly one signed queue entry under scope ${scope.slice(0, 12)} (${queued[0] ?? claimedAlready[0]})`);

  // The dispatched prompt itself, read back off the transcript. The operator's note has to be in
  // the message that starts the learning turn, and it has to be the ONLY message this stop sent:
  // the page used to send a second one behind it, which reached the agent mid-turn.
  const userMessages = async () => (await transcriptEntries(probe.id))
    .filter((entry) => entry.kind === "message" && entry.role === "user")
    .map(entryText);
  let prompts = [];
  const promptBy = Date.now() + PROMPT_TIMEOUT_MS;
  while (Date.now() < promptBy) {
    prompts = await userMessages();
    if (prompts.length > 0) break;
    await sleep(3000);
  }
  if (prompts.length === 0) fail(`no user message reached the probe within ${PROMPT_TIMEOUT_MS / 1000}s; the learning turn was never dispatched`);
  console.log(`user messages on the probe (${prompts.length}):\n${prompts.map((text) => `  ${text.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}`);
  const learningPrompt = prompts.find((text) => text.includes("The recording is finished."));
  if (learningPrompt == null) fail(`no dispatched message says the recording is finished: ${JSON.stringify(prompts).slice(0, 300)}`);
  if (!learningPrompt.includes(`The operator says: ${OPERATOR_NOTE}`)) {
    fail(`the learning turn's prompt does not carry the operator's note: ${JSON.stringify(learningPrompt).slice(0, 300)}`);
  }
  if (prompts.length !== 1) fail(`the save sent ${prompts.length} user messages, not one: ${JSON.stringify(prompts).slice(0, 400)}`);
  pass(`the learning turn's prompt carries the operator's note, in the one message the save sent: ${JSON.stringify(learningPrompt.slice(0, 160))}`);

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
  const said = (await transcriptEntries(probe.id))
    .filter((entry) => entry.kind === "message").slice(-4)
    .map((entry) => `  ${entry.role ?? "?"}: ${entryText(entry).replace(/\s+/g, " ").slice(0, 300)}`);
  console.log(`probe's last messages (${elapsed()}):\n${said.join("\n") || "  (nothing said yet)"}`);
  if (claimed.length === 0) fail(`the agent never claimed the queue file within ${CLAIM_TIMEOUT_MS / 1000}s; the loop does not close`);
  pass(`the agent claimed the recording: ${claimed.join(", ")}`);

  // (f) Whose the learned skill is. This is the one path in the product that stamps ownership: the
  // recipe's step 5 writes the skill with update_state, and that writer puts the agent's own id on
  // the create (extensions/memory/agent-state.ts writeWorkflow). The dashboard gate can only drive
  // createAgentWorkflow, which the console deliberately keeps global, so without this leg "the
  // Teach plane produces skills the agent owns" is measured nowhere on a box. Both halves are read
  // back: the owner on the probe's own row, and the absence of the row from a SECOND agent's
  // library, because "offered to nobody else" is what ownership buys and only another agent's list
  // can show it.
  const otherAgentId = ((await call("listAgents").catch(() => [])) ?? [])
    .find((agent) => agent.id !== probe.id && agent.isGroup !== true)?.id ?? null;
  const waitForSkill = async (ms) => {
    const by = Date.now() + ms;
    for (;;) {
      const found = (await libraryRows(probe.id)).find((workflow) => !libraryBefore.includes(workflow.id)) ?? null;
      if (found != null) return found;
      if (Date.now() > by) return null;
      await sleep(5000);
    }
  };
  let learned = await waitForSkill(SKILL_TIMEOUT_MS);
  // The turn reaches step 5 minutes after the claim on this box -- frames, then the browser
  // cross-check, then the write -- and this gate has a warden ceiling to fit. When it has not got
  // there yet, ask for the write outright: it is the same tool call the recipe makes, from the
  // same agent, so what comes back says the same thing about ownership. The log line below says
  // which of the two routes produced the skill.
  const askedFor = learned == null;
  if (askedFor) {
    console.log(`the learning turn had written no skill after ${SKILL_TIMEOUT_MS / 1000}s (${elapsed()}); asking for the write`);
    await call("sendPrompt", { agentId: probe.id, prompt: 'Save what you have learned so far as a skill now, with update_state (target "workflow", action "write"). Keep the body short. Do not wait for the rest of your analysis.' });
    learned = await waitForSkill(SKILL_NUDGE_TIMEOUT_MS);
  }
  if (learned == null) {
    fail(`the agent wrote no skill within ${(SKILL_TIMEOUT_MS + SKILL_NUDGE_TIMEOUT_MS) / 1000}s, asked outright or not; nothing here measures who a skill written through update_state belongs to`);
  }
  if (learned.ownerAgentId !== probe.id) {
    fail(`the skill "${learned.name}" (${learned.id}) came back owned by ${JSON.stringify(learned.ownerAgentId)}, not by the agent that wrote it (${probe.id}); update_state is not stamping ownership`);
  }
  if (otherAgentId == null) fail("this box has no second agent to read the library through; 'offered to nobody else' cannot be measured");
  if ((await libraryRows(otherAgentId)).some((workflow) => workflow.id === learned.id)) {
    fail(`the skill "${learned.name}" (${learned.id}) is offered to agent ${otherAgentId} as well; an owned skill reaches its owner only`);
  }
  pass(`the skill the ${askedFor ? "agent wrote when asked" : "learning turn wrote"} is its own: "${learned.name}" (${learned.id}) owned by ${learned.ownerAgentId}, and agent ${otherAgentId} is not offered it`);

  console.log(`SUMMARY: teach recording works with SAND_TEACH=1 and no Cursor login. Refused when off, recorded, discarded clean, saved with a signed queue entry, dispatched one learning turn carrying the operator's note, the whole recipe and scope ${scope.slice(0, 12)}, the agent claimed the work, and the skill it wrote with update_state belongs to it alone (${elapsed()}).`);
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
    // The library is read and written through an agent id but the global rows are shared, so the
    // sweep works through a surviving agent. It is the global rows it is after: the probe's own
    // skills went with the delete above (releaseOwnedWorkflows), and a survivor is not offered
    // them anyway. Twice, a few seconds apart: the learning turn can write one last workflow while
    // the delete above is landing, and a skill left in the shared library is a production agent's
    // problem, not this gate's.
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
