// Wave D1. The connector plane, checked against the live box rather than described.
//
// What this proves, in order:
//   CP-07  a local connector has a positive-integer id that is the SAME after a docker restart,
//          and the id-keyed operations that used to reject `local:<name>` now work.
//   CP-08  listMcpServerTools returns every tool with an enabled flag; disabling one makes it
//          vanish from listRoutedMcpTools and from what a fresh agent's GetMcpTools can see.
//   CP-10  a secret set through setConnectorSecret reaches the connector PROCESS (a probe stdio
//          server that answers with its own process.env), and the value exists nowhere under
//          /home/box/sand-data except the 0600 store -- not connectors.json, not the per-agent
//          connector-secrets/ tree, not the host log.
//   CP-05  the plugin catalog path answers with an array instead of throwing.
//   CP-12  disconnectChannel without an agent id is refused.
//
// Integration check, not a unit test: needs the box up. Only step (b)'s GetMcpTools leg spends a
// model turn; everything else drives the gateway directly.
//
//   CONNECT-1  the model's AddMcpServer tool runs its body instead of dying in config parsing.
//              Off by default because it spends a second model turn: --model-tool turns it on.
//
//   CONNECT-2  a connector that never connects does not hold listInstalledMcpServers open, and
//              removing it takes effect on a refresh instead of needing a box restart. Off by
//              default because it installs a deliberately broken connector: --stalled-server.
//
//   CONNECT-3/4  a remote connector whose credential is an API key: the preset entry goes in
//              through the console's own POST /connectors, the EMPTY-valued env key is the one
//              credential field offered, the connector stays out of the way until the key is
//              stored, and storing it through setConnectorSecret is what makes it connect. Off by
//              default because it runs a server inside the box: --tinyfish-key.
//
//   CONNECT-5  a shell tool's credential: CodeRabbit ships no MCP server at all, so its key
//              belongs to a COMMAND the agent runs, not to a connector process. The store is the
//              same 0600 file in its own section, and the destination is the environment of the
//              box shell the agent's shell tool spawns. Off by default: --shell-secrets. It does
//              NOT run either installer; the catalog is read, not executed.
//
//   node scripts/verify-connector-plane.mjs            all of it
//   node scripts/verify-connector-plane.mjs --no-restart   skip the docker restart in (a)
//   node scripts/verify-connector-plane.mjs --no-model     skip the one model turn in (b)
//   node scripts/verify-connector-plane.mjs --model-tool   add (f), the AddMcpServer turn
//   node scripts/verify-connector-plane.mjs --stalled-server  add (g), the stalled connector
//   node scripts/verify-connector-plane.mjs --tinyfish-key    add (h), the API-key connector
//   node scripts/verify-connector-plane.mjs --shell-secrets   add (i), the shell-tool credential
//              (h) and (i) imply --no-restart and --no-model so the arm fits the 280 s gate budget
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const DATA = "/home/box/sand-data";
const CONNECTORS = `${DATA}/connectors.json`;
const SECRET_STORE = `${DATA}/connector-env-secrets.json`;
const PROBE_SERVER = "envprobe";
const PROBE_SCRIPT = "/workspace/mcp-env-probe.mjs";
const PROBE_FIELD = "PROBE_SECRET";
const MODEL_TOOL = process.argv.includes("--model-tool");
const STALLED_SERVER = process.argv.includes("--stalled-server");
const TINYFISH_KEY = process.argv.includes("--tinyfish-key");
const SHELL_SECRETS = process.argv.includes("--shell-secrets");
// (h) spends a minute of its own on two deliberate 30 s windows, so on top of the docker restart
// in (a) and the model turn in (b) it does not fit the 280 s these gates are run under. The
// contract names the arm `--tinyfish-key` with no other flags, so the flag carries the two skips.
// (i) is fast, but it is run under the same 280 s and behind the same base legs, so it carries
// them too.
const NO_RESTART = process.argv.includes("--no-restart");
const NO_MODEL = process.argv.includes("--no-model");
const SKIP_RESTART = NO_RESTART || TINYFISH_KEY || SHELL_SECRETS;
const SKIP_MODEL = NO_MODEL || TINYFISH_KEY || SHELL_SECRETS;
// CONNECT-5. The one shell-tool field this arm touches. It refuses to run at all if the host
// already holds a value under it: an operator's real CodeRabbit key is not this gate's to delete.
const SHELL_FIELD = "CODERABBIT_API_KEY";
const PROBE_PREFIX = "probe-u3";
const TURN_TIMEOUT_MS = 300_000;
// CONNECT-3. The preset the console's "TinyFish (API key)" button writes, name and all. The gate
// swaps the URL for the stub's and adds --allow-http; everything else is the entry an operator gets.
const TINYFISH_SERVER = "tinyfish";
const TINYFISH_FIELD = "TINYFISH_API_KEY";
const STUB_SOURCE = readFileSync(new URL("./lib/mcp-bearer-stub.mjs", import.meta.url), "utf8");

class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
const ok = (message) => console.log(`  ok  ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let parsed; try { parsed = JSON.parse(text); } catch { return text; }
  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.error === "string") {
    throw new Error(`${method} -> ${parsed.error}`);
  }
  return parsed;
};
const callRaw = async (method, args = {}) => {
  try { return { ok: true, value: await call(method, args) }; }
  catch (error) { return { ok: false, message: error.message }; }
};

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 64 << 20 }, (error, out, err) =>
    (error ? reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${err || error.message}`)) : resolve(out))));
const inBox = (script) => docker(["exec", BOX, "sh", "-c", script]);

const waitForHost = async (label) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await callRaw("getHostStatus");
    if (status.ok) return;
    await sleep(5000);
  }
  fail(`the host never came back after ${label}`);
};

// The probe connector: a stdio MCP server whose only tool hands back its own process environment.
// That is the whole point -- a value that reaches this tool reached the connector PROCESS, which a
// file beside connectors.json never would have.
const PROBE_SOURCE = `const send=(m)=>process.stdout.write(JSON.stringify(m)+"\\n");
let buf="";
process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}
if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:m.params&&m.params.protocolVersion||"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"envprobe",version:"0.0.1"}}});
else if(m.method==="tools/list")send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"env_probe",description:"Returns this server process's ${PROBE_FIELD}.",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}});
else if(m.method==="tools/call")send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:String(process.env.${PROBE_FIELD}||"(unset)")}],isError:false}});
else if(m.id!==undefined)send({jsonrpc:"2.0",id:m.id,result:{}});}});
`;

const readConnectorsJson = async () => JSON.parse(await inBox(`cat ${CONNECTORS}`));
// Byte-exact, because (f) promises to put the file back exactly as it found it and a JSON
// round-trip is not that: it loses key order, trailing newline and indentation.
const readConnectorsBase64 = async () => (await inBox(`base64 < ${CONNECTORS} | tr -d '\\n'`)).trim();
// null means the file is not there at all, which is a different answer from "empty" and has to
// survive the round trip: the secret store does not exist until the first secret is stored.
const readFileBase64 = async (path) =>
  (await inBox(`test -f ${path} && base64 < ${path} | tr -d '\\n' || true`)).trim() || null;
// CONNECT-5: (i) puts the secret store back the way it found it, including "it did not exist".
const restoreSecretStoreBase64 = async (encoded) => {
  if (encoded == null) { await inBox(`rm -f ${SECRET_STORE}`); return; }
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(SECRET_STORE)},Buffer.from(${JSON.stringify(encoded)},'base64'),{mode:0o600})`]);
};
const restoreConnectorsBase64 = async (encoded) => {
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(CONNECTORS)},Buffer.from(${JSON.stringify(encoded)},'base64'),{mode:0o600})`]);
};
// The action ledger is the only surface that carries a tool's NAME next to its result: the
// conversation outline keeps the completed row, and a completed row has lost which tool it was.
const auditRecords = async (agentId) => {
  const raw = await inBox(`cat ${DATA}/agents/${agentId}/audit.jsonl 2>/dev/null || true`);
  return raw.split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
};
const toolResults = async (agentId, toolName) =>
  (await auditRecords(agentId)).filter((record) => record.type === "tool_result" && record.tool === toolName);

// A turn is over when the agent has been seen running and has stopped. Waiting only for "not
// running" would return the instant the prompt is posted, before the run has even started.
const runTurn = async (agentId, prompt, timeoutMs) => {
  await call("sendPrompt", { agentId, prompt });
  const deadline = Date.now() + timeoutMs;
  let seenRunning = false;
  const startBy = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const running = (await call("listAgents")).find((agent) => agent.id === agentId)?.isRunning === true;
    if (running) { seenRunning = true; continue; }
    if (seenRunning || Date.now() > startBy) return true;
  }
  return false;
};
const writeConnectorsJson = async (value) => {
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(CONNECTORS)},${JSON.stringify(JSON.stringify(value, null, 2))},{mode:0o600})`]);
};

// The console does not write connectors.json through the gateway -- it POSTs the whole map to the
// relay, which is the only path with the box's file behind it. (h) uses that path rather than a
// docker write, because the claim being made is about what the operator's Save button does.
const saveConnectorsThroughRelay = async (servers) => {
  const res = await fetch(`${GATEWAY}/connectors`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ mcpServers: servers }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /connectors -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

// The stub server (scripts/lib/mcp-bearer-stub.mjs) runs INSIDE the box, because the connector that
// has to reach it runs there too. The key travels in the environment, never in an argument: the
// box's own ps would otherwise carry it, which is the failure this whole arm is about.
const startStub = async (path, port, key) => {
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(path)},${JSON.stringify(STUB_SOURCE)})`]);
  await docker(["exec", "-d", "-e", `MCP_STUB_KEY=${key}`, BOX, "sh", "-c",
    `node ${path} --port ${port} > ${path}.log 2>&1`]);
};
// One request at the stub from inside the box, printed as "<status> <body>". Used to know the stub
// is up before a connector is pointed at it, so a connector that never connects means the connector.
const askStub = async (port, authorization) => {
  const out = await docker(["exec", "-e", `STUB_AUTH=${authorization}`, BOX, "node", "-e",
    `fetch("http://127.0.0.1:${port}/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",` +
    `...(process.env.STUB_AUTH?{authorization:process.env.STUB_AUTH}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})})` +
    `.then((r)=>r.text().then((t)=>console.log(r.status+" "+t.replace(/\\s+/g," ").slice(0,300)))).catch((e)=>console.log("ERR "+e.message))`]);
  return out.trim();
};
// The pattern goes in through the environment so pkill's own command line does not match it. The
// .auth directory is mcp-remote's own store, pointed here by MCP_REMOTE_CONFIG_DIR so that a gate
// run leaves nothing in the box user's home either.
const stopStub = async (path) => {
  await docker(["exec", "-e", `STUB_PATH=${path}`, BOX, "sh", "-c",
    'pkill -f "$STUB_PATH" >/dev/null 2>&1; rm -f "$STUB_PATH" "$STUB_PATH.log"; rm -rf "$STUB_PATH.auth"; exit 0']);
};

const routedTools = async () => {
  const tools = await call("listRoutedMcpTools");
  return Array.isArray(tools) ? tools : [];
};
const waitForRoutedTool = async (toolName, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await routedTools()).find((tool) => tool.toolName === toolName);
    if (found != null) return found;
    await sleep(4000);
  }
  return null;
};

const waitForServerTools = async (serverId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await call("listMcpServerTools", { serverId }).catch(() => []);
    if (Array.isArray(seen) && seen.length > 0) return seen;
    await sleep(4000);
  }
  return seen;
};

let probeSecretSet = false;
let probeInstalled = false;
let probeAgentId = null;
let originalConnectors = null;
let modelToolAgentId = null;
let connectorsSnapshot = null;
let stalledSnapshot = null;
let stalledMarker = null;
let tinyfishSnapshot = null;
let tinyfishSecretSet = false;
let stubPath = null;
let shellSecretSet = false;
let shellStoreSnapshot = null;
let shellStoreSnapshotTaken = false;

try {
  console.log(`gateway ${GATEWAY}  box ${BOX}`);

  // ---------------------------------------------------------------- (a) CP-07 stable numeric id
  console.log("\n(a) CP-07 — a stable numeric id for a local connector");
  const installedBefore = await call("listInstalledMcpServers");
  if (!Array.isArray(installedBefore)) fail("listInstalledMcpServers did not return an array");
  const localfiles = installedBefore.find((server) => server.serverIdentifier === "localfiles");
  if (localfiles == null) fail("listInstalledMcpServers does not show the localfiles connector");
  if (!/^[1-9]\d*$/.test(String(localfiles.id))) {
    fail(`localfiles id "${localfiles.id}" is not a positive decimal string; validateMcpServerId would reject it`);
  }
  const SERVER_ID = String(localfiles.id);
  ok(`localfiles id=${SERVER_ID} transport=${localfiles.transport} status=${localfiles.status} tools=${localfiles.toolCount}`);

  if (SKIP_RESTART) console.log(`  --  docker restart skipped (${NO_RESTART ? "--no-restart" : "--tinyfish-key"})`);
  else {
    await docker(["restart", BOX]);
    await sleep(10_000);
    await waitForHost("docker restart");
    const after = (await call("listInstalledMcpServers")).find((server) => server.serverIdentifier === "localfiles");
    if (after == null) fail("localfiles disappeared after the restart");
    if (String(after.id) !== SERVER_ID) fail(`the id moved across a restart: ${SERVER_ID} -> ${after.id}`);
    ok(`the id is still ${after.id} after a docker restart`);
  }

  // ------------------------------------------------------- (b) CP-08 per-tool permission reads
  console.log("\n(b) CP-08 — per-tool enablement, keyed by that id");
  // A stdio connector is spawned and discovered lazily, so straight after a restart the server
  // exists with an id and no tools yet. Waiting for the first non-empty read is the difference
  // between checking the toggle path and checking how fast the box boots.
  const tools = await waitForServerTools(SERVER_ID, 180_000);
  if (!Array.isArray(tools) || tools.length !== 14) {
    fail(`listMcpServerTools returned ${Array.isArray(tools) ? tools.length : "a non-array"}, expected 14 tools`);
  }
  if (tools.some((tool) => typeof tool.enabled !== "boolean")) fail("a tool row has no enabled flag");
  ok(`${tools.length} tools, all with an enabled flag (${tools.filter((tool) => tool.enabled).length} enabled)`);

  const VICTIM = "search_files";
  if (!tools.some((tool) => tool.name === VICTIM)) fail(`localfiles has no ${VICTIM} tool to toggle`);
  const disabled = await call("toggleMcpToolDisabled", { serverId: SERVER_ID, toolName: VICTIM, disabled: true });
  if (disabled.find((tool) => tool.name === VICTIM)?.enabled !== false) fail(`${VICTIM} did not come back disabled`);
  if ((await routedTools()).some((tool) => tool.toolName === VICTIM)) {
    fail(`${VICTIM} is still in listRoutedMcpTools after being disabled`);
  }
  ok(`${VICTIM} disabled and gone from listRoutedMcpTools`);

  if (SKIP_MODEL) console.log(`  --  the GetMcpTools leg is skipped (${NO_MODEL ? "--no-model" : "--tinyfish-key"})`);
  else {
    const created = await call("createAgent", { name: `verify-cp-${Math.random().toString(36).slice(2, 8)}` });
    probeAgentId = created?.agent?.id ?? created?.id;
    if (probeAgentId == null) fail("createAgent returned no agent id");
    await call("sendPrompt", {
      agentId: probeAgentId,
      prompt: `Call GetMcpTools for the server "localfiles" and reply with ONLY the comma-separated tool names it lists. Do not call any other tool.`,
    });
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let outlineRow = null;
    let reply = null;
    while (Date.now() < deadline) {
      await sleep(6000);
      const outline = await call("getConversationOutline", { id: probeAgentId }).catch(() => []);
      outlineRow = (Array.isArray(outline) ? outline : []).find((row) =>
        row.kind === "tool-call" && /getMcpTools/i.test(String(row.name ?? ""))) ?? outlineRow;
      const running = (await call("listAgents")).find((agent) => agent.id === probeAgentId)?.isRunning === true;
      const spoken = (await call("getAgentTranscript", { id: probeAgentId })).filter((entry) => entry.kind === "send-message");
      reply = spoken.at(-1) ?? reply;
      if (outlineRow != null && reply != null && !running) break;
    }
    if (outlineRow == null) fail("the probe agent never called GetMcpTools");
    const answer = `${String(reply?.message?.content ?? "")} ${String(outlineRow.summary ?? "")}`;
    console.log(`  GetMcpTools answer: ${answer.replace(/\s+/g, " ").slice(0, 220)}`);
    if (new RegExp(`\\b${VICTIM}\\b`).test(answer)) fail(`the model's GetMcpTools answer still names ${VICTIM}`);
    if (!/list_directory|read_text_file|directory_tree/.test(answer)) {
      fail("the GetMcpTools answer names no localfiles tool at all; the check proved nothing");
    }
    ok(`a fresh agent's GetMcpTools answer omits ${VICTIM}`);
  }

  const reenabled = await call("toggleMcpToolDisabled", { serverId: SERVER_ID, toolName: VICTIM, disabled: false });
  if (reenabled.find((tool) => tool.name === VICTIM)?.enabled !== true) fail(`${VICTIM} did not come back enabled`);
  if (!(await routedTools()).some((tool) => tool.toolName === VICTIM)) fail(`${VICTIM} did not return to listRoutedMcpTools`);
  ok(`${VICTIM} re-enabled and back in listRoutedMcpTools`);

  // ------------------------------------------ (c) CP-10 the secret reaches the connector process
  console.log("\n(c) CP-10 — a secret into the connector process, and nowhere else");
  const SECRET = `PROBE-SECRET-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  console.log(`  probe value: ${SECRET.length} characters (never printed)`);

  originalConnectors = await readConnectorsJson();
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(PROBE_SCRIPT)},${JSON.stringify(PROBE_SOURCE)})`]);
  await writeConnectorsJson({
    mcpServers: {
      ...originalConnectors.mcpServers,
      // CONNECT-4. The empty value is how an entry declares a credential field: the host offers
      // (and stores) only env keys the entry leaves empty, so a configuration key such as a
      // directory path can no longer be captioned "Enter securely" and swallow a pasted key.
      [PROBE_SERVER]: { command: "node", args: [PROBE_SCRIPT], env: { [PROBE_FIELD]: "" } },
    },
  });
  probeInstalled = true;
  await call("refreshMcp", {});
  const probeTool = await waitForRoutedTool("env_probe", 120_000);
  if (probeTool == null) fail("the probe connector never appeared in listRoutedMcpTools");
  ok(`the probe connector is routed: ${probeTool.name}`);

  const probeInstalledRow = (await call("listInstalledMcpServers")).find((server) => server.serverIdentifier === PROBE_SERVER);
  if (probeInstalledRow == null || !/^[1-9]\d*$/.test(String(probeInstalledRow.id))) {
    fail("the probe connector got no numeric id");
  }
  ok(`the probe connector's id is ${probeInstalledRow.id}`);

  const runProbe = async () => {
    const result = await call("executeRoutedMcpTool", {
      providerIdentifier: PROBE_SERVER,
      toolName: probeTool.name,
      name: probeTool.toolName,
      args: {},
      toolCallId: `verify-connector-plane-${Date.now()}`,
    });
    return JSON.stringify(result);
  };

  const before = await runProbe();
  if (before.includes(SECRET)) fail("the probe already answers with the secret; the check would prove nothing");
  ok(`before the secret is set, env_probe answers without it`);

  probeSecretSet = true;
  const stored = await call("setConnectorSecret", { server: PROBE_SERVER, field: PROBE_FIELD, value: SECRET });
  if (stored?.stored !== true) fail("setConnectorSecret did not report the value stored");
  if (JSON.stringify(stored).includes(SECRET)) fail("setConnectorSecret echoed the value back");
  ok(`setConnectorSecret stored=${stored.stored} restarted=${stored.restarted} fields=[${stored.fields.join(", ")}]`);

  const fields = await call("listConnectorSecretFields", { server: PROBE_SERVER });
  if (!fields.fields.includes(PROBE_FIELD)) fail("listConnectorSecretFields does not list the field");
  if (JSON.stringify(fields).includes(SECRET)) fail("listConnectorSecretFields returned the value, not just the name");
  ok(`listConnectorSecretFields returns names only: [${fields.fields.join(", ")}]`);

  // Two refusals on the same path, because both used to be accepted. A plain object answers a
  // truthiness membership test for every Object.prototype key, so "constructor" resolved to a
  // connector that does not exist (with an undefined id); and a POSIX-legal env name is not enough
  // when the model picks the name -- NODE_OPTIONS on a `node` connector is code execution wearing
  // a credential's clothes.
  const ghost = await callRaw("setConnectorSecret", { server: "constructor", field: PROBE_FIELD, value: "PROBE-SECRET-GHOST" });
  if (ghost.ok) fail("setConnectorSecret accepted an Object.prototype key as a connector name");
  ok(`a prototype key is not a connector: ${ghost.message.split("->").at(-1).trim().slice(0, 90)}`);
  const control = await callRaw("setConnectorSecret", { server: PROBE_SERVER, field: "NODE_OPTIONS", value: "PROBE-SECRET-CONTROL" });
  if (control.ok) fail("setConnectorSecret accepted NODE_OPTIONS as a field name");
  ok("process-control env names (NODE_OPTIONS, LD_*, PATH) are refused as fields");

  let answered = "";
  const probeDeadline = Date.now() + 90_000;
  while (Date.now() < probeDeadline) {
    answered = await runProbe();
    if (answered.includes(SECRET)) break;
    await sleep(5000);
  }
  if (!answered.includes(SECRET)) {
    fail(`env_probe never saw ${PROBE_FIELD} after the restart; the value did not reach the connector process`);
  }
  ok(`env_probe answers with the stored value: the secret reached the connector process`);

  // Custody: the value must exist under sand-data ONLY in the 0600 host store.
  const grep = await inBox(`grep -rl -- ${SECRET} ${DATA} 2>/dev/null || true`);
  const hits = grep.split("\n").map((line) => line.trim()).filter(Boolean);
  console.log(`  files under ${DATA} containing the value: ${hits.join(", ") || "(none)"}`);
  if (hits.length !== 1 || !hits[0].endsWith("/connector-env-secrets.json")) {
    fail(`the value is in ${hits.length} file(s); expected only connector-env-secrets.json`);
  }
  const mode = (await inBox(`stat -c %a ${hits[0]}`)).trim();
  if (mode !== "600") fail(`the connector secret store is mode ${mode}, expected 600`);
  ok(`only ${hits[0]} holds it, mode ${mode}`);
  // `grep -c` prints 0 AND exits 1 on no match, so an `|| echo 0` fallback would double the line.
  const logHit = (await inBox(`grep -c -- ${SECRET} /tmp/sand-host.log 2>/dev/null | head -1`)).trim();
  if (logHit !== "" && logHit !== "0") fail(`the host log contains the value ${logHit} time(s)`);
  ok("the host log does not contain the value");

  const removed = await call("deleteConnectorSecret", { server: PROBE_SERVER, field: PROBE_FIELD });
  probeSecretSet = removed?.removed !== true;
  if (removed?.removed !== true) fail("deleteConnectorSecret did not remove the field");
  const leftover = (await inBox(`grep -rl -- ${SECRET} ${DATA} 2>/dev/null || true`)).trim();
  if (leftover.length > 0) fail(`the value survives deletion in: ${leftover}`);
  ok("deleteConnectorSecret removes it from the store");

  // ----------------------------------------------------------- (d) CP-05 the catalog cannot throw
  console.log("\n(d) CP-05 — the plugin catalog path answers instead of throwing");
  const plugins = await call("listMcpPlugins");
  if (!Array.isArray(plugins)) fail("listMcpPlugins did not return an array");
  ok(`listMcpPlugins returned ${plugins.length} plugin(s) with no throw`);
  const missing = await call("getMcpPlugin", { id: "definitely-not-a-plugin-id" });
  if (missing !== null) fail("getMcpPlugin invented a plugin for an unknown id");
  ok("getMcpPlugin answers null for an unknown id");

  // --------------------------------------------------- (e) CP-12 disconnectChannel needs an agent
  console.log("\n(e) CP-12 — disconnectChannel refuses a call with no agent id");
  const refused = await callRaw("disconnectChannel", { platform: "slack" });
  if (refused.ok) fail("disconnectChannel accepted a call with no agent id");
  if (!/agent id/i.test(refused.message)) fail(`disconnectChannel failed for the wrong reason: ${refused.message}`);
  ok(`refused: ${refused.message.split("->").at(-1).trim()}`);

  // ------------------------------------------- (f) CONNECT-1 the AddMcpServer tool runs its body
  // AddMcpServer used to die on "parse7 is not a function": the manager asked its caller for a
  // config validator and no caller ever supplied one, so the tool never reached the account at
  // all. The tool takes a REMOTE url and nothing else -- stdio connectors are the operator's
  // connectors.json, not this tool -- so the probe is a remote endpoint and the claim is that the
  // tool executes its own body and gets as far as the account write.
  if (!MODEL_TOOL) console.log("\n(f) CONNECT-1 — the AddMcpServer turn is skipped (pass --model-tool)");
  else {
    console.log("\n(f) CONNECT-1 — the model's AddMcpServer tool runs its body");
    connectorsSnapshot = await readConnectorsBase64();
    const probeName = `${PROBE_PREFIX}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await call("createAgent", { name: `verify-cp-connect-${probeName}` });
    modelToolAgentId = created?.agent?.id ?? created?.id;
    if (modelToolAgentId == null) fail("createAgent returned no agent id for the AddMcpServer probe");

    // Two attempts, the tool named outright both times. A model that still will not call it is a
    // real result about the model, and this gate exists to prove the tool, so it fails.
    const prompts = [
      `Call the AddMcpServer tool exactly once with name "${probeName}" and url "https://mcp.deepwiki.com/mcp". I have already agreed to this; do not ask me to confirm. When the tool returns, reply with its exact output text and nothing else.`,
      `You did not call it. Call the tool named AddMcpServer now — that exact tool — with name "${probeName}" and url "https://mcp.deepwiki.com/mcp". Do not ask any question first. Then reply with the tool's exact output text.`,
    ];
    let results = [];
    for (const prompt of prompts) {
      if (!await runTurn(modelToolAgentId, prompt, TURN_TIMEOUT_MS)) fail("the AddMcpServer probe turn never settled");
      results = await toolResults(modelToolAgentId, "AddMcpServer");
      if (results.length > 0) break;
      console.log("  --  no AddMcpServer call in that attempt; asking once more");
    }
    if (results.length === 0) fail("the model would not call AddMcpServer in two attempts, so the tool is unproven");
    const head = String(results.at(-1).head ?? "");
    console.log(`  AddMcpServer returned: ${head.replace(/\s+/g, " ").slice(0, 240)}`);
    if (/is not a function|TypeError/.test(head)) fail(`AddMcpServer died before its body ran: ${head.slice(0, 200)}`);
    ok("AddMcpServer ran and returned something that is not a TypeError");

    if (new RegExp(`Added "${probeName}"`).test(head)) {
      const installed = (await call("listInstalledMcpServers")).find((server) =>
        server.serverIdentifier === probeName || server.name === probeName);
      if (installed == null) fail(`AddMcpServer reported success but ${probeName} is not in listInstalledMcpServers`);
      ok(`listInstalledMcpServers shows ${probeName} id=${installed.id}`);
      const added = await waitForServerTools(String(installed.id), 120_000);
      if (!Array.isArray(added) || added.length === 0) fail(`listMcpServerTools lists no tools for ${probeName}`);
      ok(`listMcpServerTools lists ${added.length} tool(s) for ${probeName}`);
      if (!await runTurn(modelToolAgentId,
        `Call the UninstallMcpServer tool once for server_id "${installed.id}". I have already agreed; do not ask me to confirm.`,
        TURN_TIMEOUT_MS)) fail("the UninstallMcpServer turn never settled");
      const removals = await toolResults(modelToolAgentId, "UninstallMcpServer");
      if (removals.length === 0) fail("the model would not call UninstallMcpServer, so the probe server is still installed");
      if ((await call("listInstalledMcpServers")).some((server) => server.serverIdentifier === probeName || server.name === probeName)) {
        fail(`${probeName} survived UninstallMcpServer`);
      }
      ok(`${probeName} is gone from listInstalledMcpServers`);
    } else if (/inference credential|signed-in Cursor account|Managing MCP servers requires/.test(head)) {
      // The write lands on the Cursor account, not on this machine. On a box with no account the
      // tool can only get this far, and getting this far IS the thing CONNECT-1 broke.
      ok("AddMcpServer reached the account write and stopped there: this box has no signed-in account");
    } else {
      fail(`AddMcpServer failed for an unrecognised reason: ${head.slice(0, 300)}`);
    }

    if (await readConnectorsBase64() !== connectorsSnapshot) fail("the AddMcpServer turn changed connectors.json");
    ok("connectors.json is byte-identical: the account tool did not touch the local connector plane");
  }

  // ------------------------------------------ (g) CONNECT-2 a connector that cannot ever connect
  // The TinyFish bridge sat waiting on an OAuth sign-in that never came, and every MCP list call
  // waited out its sixty-second connection timeout behind it -- the console boots on those lists,
  // so the page took over a minute to paint. Removing the entry did not clear it either; the host
  // was still holding the loaded server, and only a box restart got rid of it. This arm installs
  // that shape on purpose: a command that starts and then says nothing, which is what a connector
  // waiting on a sign-in looks like from the box's side.
  if (!STALLED_SERVER) console.log("\n(g) CONNECT-2 — the stalled-connector arm is skipped (pass --stalled-server)");
  else {
    console.log("\n(g) CONNECT-2 — a stalled connector is reported, not awaited");
    stalledSnapshot = await readConnectorsBase64();
    const beforeStalled = await readConnectorsJson();
    stalledMarker = `stalled-${Math.random().toString(36).slice(2, 8)}`;
    await writeConnectorsJson({
      ...beforeStalled,
      mcpServers: {
        ...beforeStalled.mcpServers,
        [stalledMarker]: { command: "sh", args: ["-c", `sleep 600 # ${stalledMarker}`] },
      },
    });
    await call("refreshMcp", {});

    let installed = [];
    let row = null;
    let elapsed = 0;
    const appearBy = Date.now() + 60_000;
    while (Date.now() < appearBy) {
      const started = Date.now();
      installed = await call("listInstalledMcpServers");
      elapsed = Date.now() - started;
      row = installed.find((server) => server.serverIdentifier === stalledMarker || server.name === stalledMarker);
      if (row != null) break;
      await sleep(3000);
    }
    if (row == null) fail(`${stalledMarker} never appeared in listInstalledMcpServers`);
    if (elapsed > 5000) fail(`listInstalledMcpServers took ${elapsed} ms with a stalled connector installed`);
    if (row.status === "connected") fail(`${stalledMarker} reports connected, so this arm proves nothing`);
    ok(`listInstalledMcpServers answered in ${elapsed} ms; ${stalledMarker} status=${row.status}${row.statusDetail ? ` (${row.statusDetail})` : ""}`);
    // The rest of the plane is still on the page while that one hangs: the list answers from the
    // last known state rather than going silent because one server is mid-connect.
    if (!installed.some((server) => server.serverIdentifier === "localfiles")) {
      fail("the stalled connector took the other connectors off the list");
    }
    ok(`the other ${installed.length - 1} connector row(s) are still listed`);

    await writeConnectorsJson(beforeStalled);
    const refreshStarted = Date.now();
    await call("refreshMcp", {});
    const refreshElapsed = Date.now() - refreshStarted;
    const afterStalled = await call("listInstalledMcpServers");
    if (afterStalled.some((server) => server.serverIdentifier === stalledMarker || server.name === stalledMarker)) {
      fail(`${stalledMarker} survived the refresh; it would take a box restart to clear it`);
    }
    ok(`${stalledMarker} is gone after refreshMcp (${refreshElapsed} ms), with no box restart`);
  }

  // ---------------------------------------- (h) CONNECT-3/4 a connector whose credential is a key
  // The operator installed TinyFish by hand, then pasted his key into a field the card should never
  // have offered (MCP_REMOTE_CONFIG_DIR, a path). The mechanism has to exist without him: a preset
  // that carries the key as an EMPTY env value, a host that treats exactly that emptiness as "this
  // is the credential", and a connector that will not connect until the key is stored -- without
  // ever holding the operator's real key open to a page, a log or connectors.json.
  //
  // The far end is a stub inside the box, not agent.tinyfish.ai, so the arm needs no real key and
  // no network: the same 401-unless-Bearer shape, with an invented key that lives for one run.
  if (!TINYFISH_KEY) console.log("\n(h) CONNECT-3/4 — the API-key connector arm is skipped (pass --tinyfish-key)");
  else {
    console.log("\n(h) CONNECT-3/4 — an API-key connector: the preset, the credential field, the key");
    const KEY = `tf-stub-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
    const PORT = 39_000 + Math.floor(Math.random() * 2000);
    const ECHO = `tinyfish-echo-${Math.random().toString(36).slice(2, 10)}`;
    console.log(`  invented key: ${KEY.length} characters (never printed), stub on 127.0.0.1:${PORT}`);

    // Refuse rather than clobber. If this box has a real TinyFish key stored, setConnectorSecret
    // below would overwrite it with the invented one and nothing could put it back.
    const storeBefore = await inBox(`cat ${SECRET_STORE} 2>/dev/null || echo '{}'`);
    let storedFields = [];
    try { storedFields = Object.keys(JSON.parse(storeBefore)?.servers?.[TINYFISH_SERVER] ?? {}); } catch {}
    if (storedFields.includes(TINYFISH_FIELD)) {
      fail(`this box already holds a stored ${TINYFISH_FIELD} for "${TINYFISH_SERVER}"; this arm would overwrite a real key, so it stops here`);
    }

    tinyfishSnapshot = await readConnectorsBase64();
    const secretsSnapshot = await readFileBase64(SECRET_STORE);
    const beforeTinyfish = await readConnectorsJson();

    stubPath = `/tmp/mcp-bearer-stub-${Math.random().toString(36).slice(2, 8)}.mjs`;
    await startStub(stubPath, PORT, KEY);
    let unauthorised = "";
    let authorised = "";
    const stubDeadline = Date.now() + 30_000;
    while (Date.now() < stubDeadline) {
      unauthorised = await askStub(PORT, "");
      authorised = await askStub(PORT, `Bearer ${KEY}`);
      if (unauthorised.startsWith("401") && authorised.startsWith("200")) break;
      await sleep(2000);
    }
    if (!unauthorised.startsWith("401")) fail(`the stub answered "${unauthorised.slice(0, 120)}" with no bearer, expected 401`);
    if (!authorised.startsWith("200")) fail(`the stub answered "${authorised.slice(0, 120)}" with the bearer, expected 200`);
    if (!/search/.test(authorised) || !/fetch_content/.test(authorised)) fail("the stub's tool list names neither search nor fetch_content");
    if (`${unauthorised}${authorised}`.includes(KEY)) fail("the stub echoed the key back in an answer");
    ok(`the stub refuses without the bearer (401) and lists search + fetch_content with it`);

    // The preset entry, with the URL pointed at the stub and --allow-http for a plain http
    // endpoint. The key is NOT here: `${TINYFISH_FIELD}` goes in as an empty env value, which is
    // the whole of CONNECT-4's rule -- empty means credential, non-empty means configuration.
    //
    // MCP_REMOTE_CONFIG_DIR is the second env key on purpose. It is a PATH, and it is the exact key
    // the card offered as a credential on the day the operator pasted his real key into it; a field
    // list that answers [TINYFISH_API_KEY] with this sitting beside it is the rule being enforced
    // rather than a coincidence of there being only one key. Pointing it at the stub's own
    // directory also keeps mcp-remote's auth store out of the box user's home.
    const entry = {
      command: "npx",
      args: ["-y", "mcp-remote", `http://127.0.0.1:${PORT}/mcp`, "--transport", "http-only",
        "--header", `Authorization:Bearer \${${TINYFISH_FIELD}}`, "--allow-http"],
      env: { [TINYFISH_FIELD]: "", MCP_REMOTE_CONFIG_DIR: `${stubPath}.auth` },
    };
    const saved = await saveConnectorsThroughRelay({ ...beforeTinyfish.mcpServers, [TINYFISH_SERVER]: entry });
    if (!Array.isArray(saved.saved) || !saved.saved.includes(TINYFISH_SERVER)) {
      fail(`POST /connectors did not report ${TINYFISH_SERVER} saved: ${JSON.stringify(saved).slice(0, 200)}`);
    }
    await call("refreshMcp", {});
    // The literal has to reach disk unexpanded: mcp-remote is what expands it, from the environment
    // the host merged the stored secret into. Anything expanded here is a key written into a file.
    const written = (await readConnectorsJson()).mcpServers?.[TINYFISH_SERVER];
    if (JSON.stringify(written) !== JSON.stringify(entry)) {
      fail(`connectors.json holds a different entry than the preset: ${JSON.stringify(written).slice(0, 200)}`);
    }
    ok(`the preset entry, stub URL and MCP_REMOTE_CONFIG_DIR aside, is in connectors.json through the console's POST /connectors, with \${${TINYFISH_FIELD}} unexpanded`);

    const fieldsBefore = await call("listConnectorSecretFields", { server: TINYFISH_SERVER });
    if (JSON.stringify(fieldsBefore.fields) !== JSON.stringify([TINYFISH_FIELD])) {
      fail(`listConnectorSecretFields answers [${(fieldsBefore.fields ?? []).join(", ")}] with nothing stored, expected exactly [${TINYFISH_FIELD}]: an empty-valued env key is the credential field, and a non-empty one (MCP_REMOTE_CONFIG_DIR, a path) is configuration that must never be offered as one`);
    }
    ok(`listConnectorSecretFields answers exactly [${TINYFISH_FIELD}], with MCP_REMOTE_CONFIG_DIR on the entry and not offered`);

    // Thirty seconds of watching it NOT connect. The list is read the whole time because a
    // connector waiting on a credential must not be something the console waits on: that is what
    // made the Plugins panel take a minute to paint.
    let keyless = null;
    let slowest = 0;
    const keylessDeadline = Date.now() + 30_000;
    while (Date.now() < keylessDeadline) {
      const started = Date.now();
      const installed = await call("listInstalledMcpServers");
      slowest = Math.max(slowest, Date.now() - started);
      keyless = installed.find((server) => server.serverIdentifier === TINYFISH_SERVER) ?? keyless;
      if (keyless?.status === "connected") fail(`${TINYFISH_SERVER} reached connected with no key stored; the stub would have had to accept an empty bearer`);
      await sleep(3000);
    }
    if (keyless == null) fail(`${TINYFISH_SERVER} never appeared in listInstalledMcpServers`);
    if (!["initializing", "error"].includes(String(keyless.status))) {
      fail(`with no key stored ${TINYFISH_SERVER} reports status=${keyless.status}, expected initializing or error`);
    }
    if (slowest > 5000) fail(`listInstalledMcpServers took ${slowest} ms while the keyless connector was mid-connect`);
    ok(`with no key stored: status=${keyless.status}${keyless.statusDetail ? ` (${keyless.statusDetail})` : ""}, and the list never took longer than ${slowest} ms`);

    tinyfishSecretSet = true;
    const storedKey = await call("setConnectorSecret", { server: TINYFISH_SERVER, field: TINYFISH_FIELD, value: KEY });
    if (storedKey?.stored !== true) fail("setConnectorSecret did not report the key stored");
    if (JSON.stringify(storedKey).includes(KEY)) fail("setConnectorSecret echoed the key back");
    ok(`setConnectorSecret stored=${storedKey.stored} restarted=${storedKey.restarted}`);

    let connected = null;
    const connectDeadline = Date.now() + 30_000;
    while (Date.now() < connectDeadline) {
      connected = (await call("listInstalledMcpServers")).find((server) => server.serverIdentifier === TINYFISH_SERVER) ?? connected;
      if (connected?.status === "connected") break;
      await sleep(3000);
    }
    if (connected?.status !== "connected") {
      // The keyless window above is also what warms npx, so mcp-remote is normally already
      // downloaded by the time the key lands. A box that cannot reach the npm registry fails here
      // rather than at the credential, and the detail is the only place that says which it was.
      fail(`${TINYFISH_SERVER} did not reach connected within 30 s of the key being stored: status=${connected?.status}${connected?.statusDetail ? ` (${connected.statusDetail})` : ""} — if the detail names npx or the registry, this box could not fetch mcp-remote and the credential path is untested rather than broken`);
    }
    ok(`storing the key restarted the connector and it reached connected, id=${connected.id}`);

    const tinyfishTools = await waitForServerTools(String(connected.id), 60_000);
    const toolNames = (Array.isArray(tinyfishTools) ? tinyfishTools : []).map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(["fetch_content", "search"])) {
      fail(`listMcpServerTools for ${TINYFISH_SERVER} lists [${toolNames.join(", ")}], expected exactly fetch_content and search`);
    }
    ok(`listMcpServerTools lists exactly [${toolNames.join(", ")}]`);

    const searchTool = await waitForRoutedTool("search", 60_000);
    if (searchTool == null) fail("the stub's search tool never reached listRoutedMcpTools");
    const echoed = JSON.stringify(await call("executeRoutedMcpTool", {
      providerIdentifier: TINYFISH_SERVER,
      toolName: searchTool.name,
      name: searchTool.toolName,
      args: { query: ECHO },
      toolCallId: `verify-connector-plane-tinyfish-${Date.now()}`,
    }));
    if (!echoed.includes(ECHO)) fail(`the search call did not come back with its own arguments: ${echoed.slice(0, 240)}`);
    if (echoed.includes(KEY)) fail("the tool answer carried the key");
    ok(`a search call through executeRoutedMcpTool came back with its own arguments`);

    const removedKey = await call("deleteConnectorSecret", { server: TINYFISH_SERVER, field: TINYFISH_FIELD });
    tinyfishSecretSet = removedKey?.removed !== true;
    if (removedKey?.removed !== true) fail("deleteConnectorSecret did not remove the key");
    // The field is still OFFERED after the value is gone, because the entry's empty env value is
    // what names it. A card that stopped offering it would have no way to put a new key in.
    const fieldsAfter = await call("listConnectorSecretFields", { server: TINYFISH_SERVER });
    if (JSON.stringify(fieldsAfter.fields) !== JSON.stringify([TINYFISH_FIELD])) {
      fail(`after the delete listConnectorSecretFields answers [${(fieldsAfter.fields ?? []).join(", ")}], expected the empty env value to keep naming [${TINYFISH_FIELD}]`);
    }
    const survivors = (await inBox(`grep -rl -- ${KEY} ${DATA} 2>/dev/null || true`)).trim();
    if (survivors.length > 0) fail(`the key survives the delete in: ${survivors}`);
    ok(`the key is gone from ${DATA} and the field is still offered: [${fieldsAfter.fields.join(", ")}]`);

    await saveConnectorsThroughRelay(beforeTinyfish.mcpServers ?? {});
    await call("refreshMcp", {});
    if ((await call("listInstalledMcpServers")).some((server) => server.serverIdentifier === TINYFISH_SERVER)) {
      fail(`${TINYFISH_SERVER} survived its removal from connectors.json`);
    }
    await stopStub(stubPath);
    stubPath = null;
    ok(`the entry is out of connectors.json and the stub is stopped`);

    // Byte-identical, not equivalent: the arm went in through the console's own write path, so the
    // file it leaves behind has to be the file it found, key order and whitespace included.
    if (await readConnectorsBase64() !== tinyfishSnapshot) fail("connectors.json is not byte-identical to what this arm found");
    const secretsNow = await readFileBase64(SECRET_STORE);
    if (secretsNow !== secretsSnapshot) {
      fail(`connector-env-secrets.json is not byte-identical to what this arm found (${secretsSnapshot == null ? "it did not exist" : "it existed"} before, ${secretsNow == null ? "it does not exist" : "it exists"} now)`);
    }
    tinyfishSnapshot = null;
    ok("connectors.json and connector-env-secrets.json are byte-identical to before the arm");
  }

  // ------------------------------------------- (i) CONNECT-5 a shell tool's credential
  if (SHELL_SECRETS) {
    console.log("\n(i) CONNECT-5 — a shell credential in the box shell's environment, and gone again");

    // The catalog is READ, never executed. Running `curl | sh` or `pip install` from a gate would
    // leave a tool on the box that the next run would find already there, and neither installer is
    // what this arm is about.
    const catalogue = await call("listShellTools");
    if (!Array.isArray(catalogue) || catalogue.length !== 2) {
      fail(`listShellTools returned ${Array.isArray(catalogue) ? catalogue.length : "a non-array"}, expected the two catalog entries`);
    }
    const coderabbit = catalogue.find((tool) => tool.id === "coderabbit");
    const tinyfishCli = catalogue.find((tool) => tool.id === "tinyfish-cli");
    if (coderabbit?.field !== SHELL_FIELD) fail(`the coderabbit entry's field is ${coderabbit?.field}, expected ${SHELL_FIELD}`);
    if (!/cli\.coderabbit\.ai\/install\.sh/.test(String(coderabbit.install))) fail("the coderabbit entry does not install from cli.coderabbit.ai");
    if (!/^cr review --agent --api-key/.test(String(coderabbit.usage))) fail(`the coderabbit usage line is "${coderabbit.usage}"`);
    if (tinyfishCli?.field !== "TINYFISH_API_KEY") fail(`the tinyfish-cli entry's field is ${tinyfishCli?.field}`);
    if (!/SKILL\.md$/.test(String(tinyfishCli.skillUrl ?? ""))) fail("the tinyfish-cli entry carries no SKILL.md to import");
    ok(`the catalog names ${catalogue.map((tool) => `${tool.id} (${tool.field})`).join(", ")} — neither installer is run here`);

    const held = await call("listShellSecretFields");
    if ((held?.stored ?? []).includes(SHELL_FIELD)) {
      fail(`the host already holds a ${SHELL_FIELD}; this arm will not overwrite an operator's key`);
    }
    if (!(held?.fields ?? []).includes(SHELL_FIELD)) fail(`listShellSecretFields does not offer ${SHELL_FIELD}`);
    shellStoreSnapshot = await readFileBase64(SECRET_STORE);
    shellStoreSnapshotTaken = true;

    const beforeShell = await call("probeShellSecret", { field: SHELL_FIELD });
    if (beforeShell?.state !== "unset") {
      fail(`the box shell already reports ${SHELL_FIELD} ${beforeShell?.state}; the check would prove nothing`);
    }
    ok(`before anything is stored, the box's own shell reports ${SHELL_FIELD} unset`);

    // Invented here and nowhere else: this is not, and must never be, a real CodeRabbit key.
    const SHELL_KEY = `cr-verify-${Math.random().toString(36).slice(2, 12)}`;
    console.log(`  probe value: ${SHELL_KEY.length} characters (never printed)`);
    const storedShell = await call("setShellSecret", { field: SHELL_FIELD, value: SHELL_KEY });
    shellSecretSet = true;
    if (storedShell?.stored !== true) fail("setShellSecret did not report the value stored");
    if (storedShell?.applied !== true) fail("setShellSecret stored the value but did not push it into the live box");
    if (JSON.stringify(storedShell).includes(SHELL_KEY)) fail("setShellSecret echoed the value back");
    ok(`setShellSecret stored=true applied=true fields=[${(storedShell.fields ?? []).join(", ")}]`);

    // The claim, asked of the box's own shell: the exec-daemon that spawns every /bin/sh the
    // agent's shell tool runs. The answer is set/unset and never the value.
    const probedShell = await call("probeShellSecret", { field: SHELL_FIELD });
    if (probedShell?.state !== "set") fail(`the box shell reports ${SHELL_FIELD} ${probedShell?.state} after it was stored`);
    if (JSON.stringify(probedShell).includes(SHELL_KEY)) fail("probeShellSecret answered with the value");
    ok(`the box shell reports ${SHELL_FIELD} set, and says nothing about its value`);

    const shellControl = await callRaw("setShellSecret", { field: "NODE_OPTIONS", value: "cr-verify-control" });
    if (shellControl.ok) fail("setShellSecret accepted NODE_OPTIONS as a field name");
    ok("process-control env names are refused on this store too");

    const shellHits = (await inBox(`grep -rl -- ${SHELL_KEY} ${DATA} 2>/dev/null || true`))
      .split("\n").map((line) => line.trim()).filter(Boolean);
    console.log(`  files under ${DATA} containing the value: ${shellHits.join(", ") || "(none)"}`);
    if (shellHits.length !== 1 || !shellHits[0].endsWith("/connector-env-secrets.json")) {
      fail(`the value is in ${shellHits.length} file(s); expected only connector-env-secrets.json`);
    }
    const shellMode = (await inBox(`stat -c %a ${shellHits[0]}`)).trim();
    if (shellMode !== "600") fail(`the secret store is mode ${shellMode}, expected 600`);
    const shellLogHit = (await inBox(`grep -c -- ${SHELL_KEY} /tmp/sand-host.log 2>/dev/null | head -1`)).trim();
    if (shellLogHit !== "" && shellLogHit !== "0") fail(`the host log contains the value ${shellLogHit} time(s)`);
    ok(`only ${shellHits[0]} holds it, mode ${shellMode}, and the host log does not`);

    const removedShell = await call("deleteShellSecret", { field: SHELL_FIELD });
    shellSecretSet = removedShell?.removed !== true;
    if (removedShell?.removed !== true) fail("deleteShellSecret did not remove the field");
    if ((removedShell?.stored ?? []).includes(SHELL_FIELD)) fail("the store still lists the field after the delete");
    const afterShell = await call("probeShellSecret", { field: SHELL_FIELD });
    if (afterShell?.state !== "unset") fail(`the box shell still reports ${SHELL_FIELD} ${afterShell?.state} after the delete`);
    ok(`after the delete the box shell reports ${SHELL_FIELD} unset again`);

    const shellSurvivors = (await inBox(`grep -rl -- ${SHELL_KEY} ${DATA} 2>/dev/null || true`)).trim();
    if (shellSurvivors.length > 0) fail(`the value survives the delete in: ${shellSurvivors}`);
    // Byte-identical, including "the store did not exist before this arm ran": a delete leaves an
    // empty section behind, which is residue even though it holds nothing.
    await restoreSecretStoreBase64(shellStoreSnapshot);
    const shellStoreNow = await readFileBase64(SECRET_STORE);
    if (shellStoreNow !== shellStoreSnapshot) {
      fail(`connector-env-secrets.json is not byte-identical to what this arm found (${shellStoreSnapshot == null ? "it did not exist" : "it existed"} before, ${shellStoreNow == null ? "it does not exist" : "it exists"} now)`);
    }
    shellStoreSnapshotTaken = false;
    ok("nothing is left behind: the value is gone and the store is the file this arm found");
  }

  console.log("\nPASS — connector plane");
} catch (error) {
  if (!(error instanceof VerificationFailed)) throw error;
  console.error(`\nFAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  // Leave the box exactly as it was found: no probe server, no probe file, no probe agent.
  // A failure anywhere between setConnectorSecret and its delete must not leave a live value in
  // the store; the probe connector is about to stop existing either way.
  //
  // (h) unwinds FIRST, before (c) puts the pre-probe connectors.json back. Both orderings restore a
  // file, and the later write wins: (h)'s snapshot still carries (c)'s probe connector, so undoing
  // (h) last would put the probe entry back after (c) had removed it. Deleting (h)'s key also has
  // to happen while its entry is still in connectors.json, because that file is what
  // deleteConnectorSecret resolves the connector through.
  // CONNECT-5: (i) unwinds before (h) for the same reason (h) unwinds before (c) -- the later arm
  // took the later snapshot, so the later arm's restore has to be overwritten by nobody.
  try {
    if (shellSecretSet) await callRaw("deleteShellSecret", { field: SHELL_FIELD });
  } catch (error) { console.error(`cleanup: shell secret — ${error.message}`); }
  try {
    if (shellStoreSnapshotTaken) await restoreSecretStoreBase64(shellStoreSnapshot);
  } catch (error) { console.error(`cleanup: secret store — ${error.message}`); }
  try {
    if (tinyfishSecretSet) await callRaw("deleteConnectorSecret", { server: TINYFISH_SERVER, field: TINYFISH_FIELD });
  } catch (error) { console.error(`cleanup: tinyfish key — ${error.message}`); }
  try {
    if (tinyfishSnapshot != null && await readConnectorsBase64() !== tinyfishSnapshot) {
      await restoreConnectorsBase64(tinyfishSnapshot);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: tinyfish connector entry — ${error.message}`); }
  try {
    if (stubPath != null) await stopStub(stubPath);
  } catch (error) { console.error(`cleanup: stub MCP server — ${error.message}`); }
  try {
    if (probeSecretSet) await callRaw("deleteConnectorSecret", { server: PROBE_SERVER, field: PROBE_FIELD });
  } catch (error) { console.error(`cleanup: probe secret — ${error.message}`); }
  try {
    if (probeInstalled && originalConnectors != null) {
      await writeConnectorsJson(originalConnectors);
      await inBox(`rm -f ${PROBE_SCRIPT}`);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: connectors.json — ${error.message}`); }
  try {
    if (probeAgentId != null) await call("deleteAgent", { id: probeAgentId });
  } catch (error) { console.error(`cleanup: probe agent — ${error.message}`); }
  try {
    if (connectorsSnapshot != null && await readConnectorsBase64() !== connectorsSnapshot) {
      await restoreConnectorsBase64(connectorsSnapshot);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: connectors.json snapshot — ${error.message}`); }
  try {
    if (modelToolAgentId != null) await call("deleteAgent", { id: modelToolAgentId });
  } catch (error) { console.error(`cleanup: AddMcpServer probe agent — ${error.message}`); }
  try {
    if (stalledSnapshot != null && await readConnectorsBase64() !== stalledSnapshot) {
      await restoreConnectorsBase64(stalledSnapshot);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: stalled connector entry — ${error.message}`); }
  try {
    // The marker goes in through the environment so that pkill's own command line does not carry
    // it: -f matches on the full command line, and a pattern that matches the killer is a way to
    // lose the shell before it finishes.
    if (stalledMarker != null) {
      await docker(["exec", "-e", `STALLED_MARKER=${stalledMarker}`, BOX, "sh", "-c",
        'pkill -f "$STALLED_MARKER" >/dev/null 2>&1; exit 0']);
    }
  } catch (error) { console.error(`cleanup: stalled connector process — ${error.message}`); }
}
