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
//   CONNECT-3/4, the other four services  the same two claims for the connectors the operator asked
//              for next: GitHub and Linear are remote API-key connectors, so they run against the
//              same in-box stub as (h) -- GitHub's with its three extra headers demanded back, so
//              "it connected" is proof the preset's toolset filter reached the far end. Slack and
//              Google are stdio packages, installed for real from npm, given invented tokens, and
//              held to a terminal answer inside 90 s: an operator who pastes a dead token must get
//              a NO, not a console that waits forever. Off by default, one flag each.
//
//   node scripts/verify-connector-plane.mjs            all of it
//   node scripts/verify-connector-plane.mjs --no-restart   skip the docker restart in (a)
//   node scripts/verify-connector-plane.mjs --no-model     skip the one model turn in (b)
//   node scripts/verify-connector-plane.mjs --model-tool   add (f), the AddMcpServer turn
//   node scripts/verify-connector-plane.mjs --stalled-server  add (g), the stalled connector
//   node scripts/verify-connector-plane.mjs --tinyfish-key    add (h), the API-key connector
//   node scripts/verify-connector-plane.mjs --github-key      add (i), GitHub's preset and headers
//   node scripts/verify-connector-plane.mjs --linear-key      add (j), Linear's preset
//   node scripts/verify-connector-plane.mjs --slack-stdio     add (k), Slack's package and token
//   node scripts/verify-connector-plane.mjs --google-stdio    add (l), Google's package and tokens
//              (h) through (l) imply --no-restart and --no-model so the arm fits the 280 s budget
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
const GITHUB_KEY = process.argv.includes("--github-key");
const LINEAR_KEY = process.argv.includes("--linear-key");
const SLACK_STDIO = process.argv.includes("--slack-stdio");
const GOOGLE_STDIO = process.argv.includes("--google-stdio");
// (h) spends a minute of its own on two deliberate 30 s windows, so on top of the docker restart
// in (a) and the model turn in (b) it does not fit the 280 s these gates are run under. The
// contract names the arm `--tinyfish-key` with no other flags, so the flag carries the two skips.
// (i) through (l) are the same shape and cost the same or more, so they carry them too.
const NO_RESTART = process.argv.includes("--no-restart");
const NO_MODEL = process.argv.includes("--no-model");
const CREDENTIAL_ARM = [
  ["--tinyfish-key", TINYFISH_KEY], ["--github-key", GITHUB_KEY], ["--linear-key", LINEAR_KEY],
  ["--slack-stdio", SLACK_STDIO], ["--google-stdio", GOOGLE_STDIO],
].find(([, on]) => on)?.[0];
const SKIP_RESTART = NO_RESTART || CREDENTIAL_ARM != null;
const SKIP_MODEL = NO_MODEL || CREDENTIAL_ARM != null;
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
const startStub = async (path, port, key, headers = {}) => {
  await docker(["exec", BOX, "node", "-e",
    `require('fs').writeFileSync(${JSON.stringify(path)},${JSON.stringify(STUB_SOURCE)})`]);
  await docker(["exec", "-d", "-e", `MCP_STUB_KEY=${key}`, "-e", `MCP_STUB_HEADERS=${JSON.stringify(headers)}`,
    BOX, "sh", "-c", `node ${path} --port ${port} > ${path}.log 2>&1`]);
};
// One request at the stub from inside the box, printed as "<status> <body>". Used to know the stub
// is up before a connector is pointed at it, so a connector that never connects means the connector.
// The headers ride in the environment for the same reason the key does: `docker exec` arguments are
// a command line, and one of these headers is the bearer.
const askStub = async (port, headers) => {
  const out = await docker(["exec", "-e", `STUB_HEADERS=${JSON.stringify(headers)}`, BOX, "node", "-e",
    `fetch("http://127.0.0.1:${port}/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",` +
    `...JSON.parse(process.env.STUB_HEADERS||"{}")},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})})` +
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
// (i) through (l) run one at a time and each unwinds itself, so the four share one set of undo
// handles: the connectors.json bytes to put back, and the credentials still in the store.
let armSnapshot = null;
let armSecrets = [];

// The four entries the operator asked for next, taken from the research reports (docs/connectors/
// {github,linear,slack,google}.md §2) rather than invented here, and from the same reports' §4 for
// the first call and what a refused credential says.
//
// GitHub and Linear are remote servers reached through `npx mcp-remote`, so their arms run against
// the in-box stub instead of api.githubcopilot.com and mcp.linear.app: an arm that needed a real
// PAT could not run at all, and one that ran against the real endpoint would be a gate on GitHub's
// uptime. Three things differ from the operator's entry and nothing else does -- the URL is the
// stub's, --allow-http is added because the stub is plain http on loopback, and MCP_REMOTE_CONFIG_DIR
// points mcp-remote's own store at a per-run directory so a gate run leaves nothing in the box
// user's home. That last one earns its place twice: it is a NON-EMPTY env value sitting beside the
// empty one, so `listConnectorSecretFields` answering with only the credential is the CONNECT-4 rule
// being enforced rather than a coincidence of there being one key.
const REMOTE_ARMS = [
  {
    on: GITHUB_KEY, flag: "--github-key", letter: "(i)", service: "GitHub", server: "github",
    field: "GITHUB_PERSONAL_ACCESS_TOKEN", keyPrefix: "gh-stub",
    // docs/connectors/github.md §2. Repeated --header arguments, and NOT credentials: they are the
    // toolset filter that decides the operator gets 23 read tools instead of the whole write
    // catalogue. A bridge that dropped them would leave a working connector and a wrong catalogue,
    // which no "it connected" catches -- so the stub demands them back.
    headers: { "X-MCP-Toolsets": "repos,issues,pull_requests", "X-MCP-Tools": "get_me", "X-MCP-Readonly": "true" },
  },
  {
    on: LINEAR_KEY, flag: "--linear-key", letter: "(j)", service: "Linear", server: "linear",
    field: "LINEAR_API_KEY", keyPrefix: "ln-stub",
    // docs/connectors/linear.md §2 carries the bearer and nothing else.
    headers: {},
  },
];

// Slack and Google are stdio packages, and these arms install the REAL pinned package from npm --
// the box has outbound network, and a stub would prove nothing about whether `npx
// slack-mcp-server@1.3.0` spawns and answers on this box at all. What cannot be real is the token,
// so each field gets an invented value: the claim is then the one an operator needs, which is that
// a credential the far end refuses ends in an answer rather than in a wait.
const STDIO_ARMS = [
  {
    on: SLACK_STDIO, flag: "--slack-stdio", letter: "(k)", service: "Slack", server: "slack",
    // docs/connectors/slack.md §2, unchanged.
    entry: { command: "npx", args: ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"], env: { SLACK_MCP_XOXP_TOKEN: "" } },
    warm: "slack-mcp-server@1.3.0",
    // docs/connectors/slack.md §4 step 2: the first call, with its arguments.
    smoke: { tool: "channels_list", args: { channel_types: "public_channel", limit: 5 } },
    // docs/connectors/slack.md §4 step 4: what Slack says to a token it does not know.
    refusal: /invalid_auth|not_authed|token_revoked|account_inactive|token_expired|missing_scope|unauthori[sz]|authentication|\b40[13]\b/i,
    // An xoxp token Slack will not know, shaped like one so a client-side format check is not what
    // refuses it. Invented here and thrown away at the end of the arm.
    invent: () => `xoxp-0000000000-0000000000-0000000000-invented${Math.random().toString(36).slice(2, 12)}`,
  },
  {
    on: GOOGLE_STDIO, flag: "--google-stdio", letter: "(l)", service: "Google", server: "google",
    // docs/connectors/google.md §2, unchanged: three credential slots, not one.
    entry: { command: "npx", args: ["-y", "google-workspace-mcp-server@1.4.3"], env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "" } },
    warm: "google-workspace-mcp-server@1.4.3",
    // docs/connectors/google.md §4 step 2: needs no message or document id.
    smoke: { tool: "gmail_list_labels", args: {} },
    // docs/connectors/google.md §4: an OAuth client or refresh token Google will not mint against.
    refusal: /invalid_grant|invalid_client|unauthorized_client|invalid_credentials|unauthori[sz]|authentication|access token|refresh token|\b40[13]\b/i,
    invent: (field) => `invented-${field.toLowerCase().replace(/_/g, "-")}-${Math.random().toString(36).slice(2, 12)}`,
  },
];

// npx fetches a package the first time a connector spawns it. On a box with a cold npm cache that
// download would be counted against the 90 s (k) and (l) give the connector to reach a terminal
// state, turning a registry round trip into a verdict about the credential path. So the download is
// kicked off detached at the start of the run and has the whole of (a) through (e) to finish; the
// arm below then measures the connector. It leaves nothing but an npm cache entry.
// `timeout` bounds it so a package whose --help starts a server instead of printing one cannot
// leave a process behind; if this image has no timeout the whole line fails into /dev/null and the
// arm simply runs with a cold cache.
const warmNpx = (spec) => docker(["exec", "-d", BOX, "sh", "-c",
  `timeout 120 npx -y ${spec} --help < /dev/null > /dev/null 2>&1`]);

// The entry an operator's console writes for a remote API-key connector, with the three gate-only
// differences described above. `${FIELD}` reaches connectors.json as those literal characters --
// mcp-remote expands it from the environment the host merged the stored secret into, so anything
// expanded here would be a credential written into a plaintext file.
const remoteEntry = (arm, port, authDir) => ({
  command: "npx",
  args: [
    "-y", "mcp-remote@0.8.3", `http://127.0.0.1:${port}/mcp`, "--transport", "http-only",
    "--header", `Authorization:Bearer \${${arm.field}}`,
    ...Object.entries(arm.headers).flatMap(([name, value]) => ["--header", `${name}:${value}`]),
    "--allow-http",
  ],
  env: { [arm.field]: "", MCP_REMOTE_CONFIG_DIR: authDir },
});

// Nothing in this file may overwrite a credential the operator actually uses: setConnectorSecret
// replaces a value in place, and no arm here could put a real one back.
const refuseIfStored = async (server, fields) => {
  const raw = await inBox(`cat ${SECRET_STORE} 2>/dev/null || echo '{}'`);
  let stored = [];
  try { stored = Object.keys(JSON.parse(raw)?.servers?.[server] ?? {}); } catch {}
  const clash = fields.filter((field) => stored.includes(field));
  if (clash.length > 0) {
    fail(`this box already holds a stored ${clash.join(", ")} for "${server}"; this arm would overwrite a real credential, so it stops here`);
  }
};

// A shell literal for a value this file invented, so a `grep -F` for it cannot be re-read by the
// shell. The only place any of these values reaches a command line at all is here, in the search
// that proves it is nowhere in the log.
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The host log is the surface an operator reads when a connector will not start, and the one place a
// credential most easily lands: a spawn line that prints the merged environment, an error that
// quotes the argv. Checked for every value the arm stored.
const assertNoneInHostLog = async (values) => {
  for (const [field, value] of Object.entries(values)) {
    // `grep -c` prints 0 AND exits 1 on no match, so an `|| echo 0` fallback would double the line.
    const hits = (await inBox(`grep -c -a -F -- ${shellQuote(value)} /tmp/sand-host.log 2>/dev/null | head -1`)).trim();
    if (hits !== "" && hits !== "0") fail(`the host log contains the ${field} value ${hits} time(s)`);
  }
  ok(`the host log holds none of the ${Object.keys(values).length} stored value(s)`);
};

// Both files back byte for byte, not equivalently: these arms write through the console's own POST
// /connectors, so the file they leave has to be the file they found, key order and trailing newline
// included. `null` for the secret store is its own answer -- it does not exist until a first secret
// is stored, and an arm that created it has not put the box back.
const assertFilesRestored = async (connectorsBase64, secretsBase64) => {
  if (await readConnectorsBase64() !== connectorsBase64) fail("connectors.json is not byte-identical to what this arm found");
  const now = await readFileBase64(SECRET_STORE);
  if (now !== secretsBase64) {
    fail(`connector-env-secrets.json is not byte-identical to what this arm found (${secretsBase64 == null ? "it did not exist" : "it existed"} before, ${now == null ? "it does not exist" : "it exists"} now)`);
  }
  ok("connectors.json and connector-env-secrets.json are byte-identical to before the arm");
};

/**
 * (i) and (j). A remote connector whose credential is an API key, for one service.
 *
 * The claims, in the order an operator meets them: the preset entry goes in through the console's
 * own write path with the credential unexpanded; the empty env value is the ONE field the card
 * offers; with nothing stored the connector does not connect and does not hold the connector list
 * open; storing the key through setConnectorSecret is what makes it connect and list tools; and
 * taking it all out again leaves connectors.json and the secret store exactly as they were.
 */
async function runRemoteKeyArm(arm) {
  console.log(`\n${arm.letter} CONNECT-3/4 — ${arm.service}: the preset entry, its one credential field, and the key`);
  const KEY = `${arm.keyPrefix}-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const PORT = 39_000 + Math.floor(Math.random() * 2000);
  console.log(`  invented key: ${KEY.length} characters (never printed), stub on 127.0.0.1:${PORT}`);

  await refuseIfStored(arm.server, [arm.field]);
  armSnapshot = await readConnectorsBase64();
  const secretsSnapshot = await readFileBase64(SECRET_STORE);
  const before = await readConnectorsJson();

  stubPath = `/tmp/mcp-bearer-stub-${Math.random().toString(36).slice(2, 8)}.mjs`;
  await startStub(stubPath, PORT, KEY, arm.headers);
  const everything = { authorization: `Bearer ${KEY}`, ...arm.headers };
  let unauthorised = "";
  let authorised = "";
  const stubDeadline = Date.now() + 30_000;
  while (Date.now() < stubDeadline) {
    unauthorised = await askStub(PORT, {});
    authorised = await askStub(PORT, everything);
    if (unauthorised.startsWith("401") && authorised.startsWith("200")) break;
    await sleep(2000);
  }
  if (!unauthorised.startsWith("401")) fail(`the stub answered "${unauthorised.slice(0, 120)}" with no bearer, expected 401`);
  if (!authorised.startsWith("200")) fail(`the stub answered "${authorised.slice(0, 120)}" with the bearer and headers, expected 200`);
  if (!/search/.test(authorised) || !/fetch_content/.test(authorised)) fail("the stub's tool list names neither search nor fetch_content");
  if (`${unauthorised}${authorised}`.includes(KEY)) fail("the stub echoed the key back in an answer");
  ok("the stub refuses without the bearer (401) and lists search + fetch_content with it");

  // The headers are only PROVED to arrive if their absence is refused. Without this the arm would
  // pass just as happily against a bridge that dropped all three.
  const headerNames = Object.keys(arm.headers);
  if (headerNames.length > 0) {
    const bearerOnly = await askStub(PORT, { authorization: `Bearer ${KEY}` });
    if (!bearerOnly.startsWith("401")) {
      fail(`the stub answered "${bearerOnly.slice(0, 120)}" to a request carrying the bearer but not ${headerNames.join(", ")}, expected 401: this arm proves those headers arrive only if their absence is refused`);
    }
    ok(`the stub also refuses the bearer alone, so reaching connected means ${headerNames.join(", ")} arrived with the preset's values`);
  }

  const entry = remoteEntry(arm, PORT, `${stubPath}.auth`);
  const saved = await saveConnectorsThroughRelay({ ...before.mcpServers, [arm.server]: entry });
  if (!Array.isArray(saved.saved) || !saved.saved.includes(arm.server)) {
    fail(`POST /connectors did not report ${arm.server} saved: ${JSON.stringify(saved).slice(0, 200)}`);
  }
  await call("refreshMcp", {});
  const written = (await readConnectorsJson()).mcpServers?.[arm.server];
  if (JSON.stringify(written) !== JSON.stringify(entry)) {
    fail(`connectors.json holds a different entry than the preset: ${JSON.stringify(written).slice(0, 200)}`);
  }
  ok(`the preset entry, stub URL and MCP_REMOTE_CONFIG_DIR aside, is in connectors.json through the console's POST /connectors, with \${${arm.field}} unexpanded`);

  const fieldsBefore = await call("listConnectorSecretFields", { server: arm.server });
  if (JSON.stringify(fieldsBefore.fields) !== JSON.stringify([arm.field])) {
    fail(`listConnectorSecretFields answers [${(fieldsBefore.fields ?? []).join(", ")}] with nothing stored, expected exactly [${arm.field}]: an empty-valued env key is the credential field, and a non-empty one (MCP_REMOTE_CONFIG_DIR, a path) is configuration that must never be offered as one`);
  }
  ok(`listConnectorSecretFields answers exactly [${arm.field}], with MCP_REMOTE_CONFIG_DIR on the entry and not offered`);

  // Thirty seconds of watching it NOT connect, reading the connector list the whole time: a
  // connector waiting on a credential must not be something the console waits on.
  let keyless = null;
  let slowest = 0;
  const keylessDeadline = Date.now() + 30_000;
  while (Date.now() < keylessDeadline) {
    const started = Date.now();
    const installed = await call("listInstalledMcpServers");
    slowest = Math.max(slowest, Date.now() - started);
    keyless = installed.find((server) => server.serverIdentifier === arm.server) ?? keyless;
    if (keyless?.status === "connected") fail(`${arm.server} reached connected with no key stored; the stub would have had to accept an empty bearer`);
    await sleep(3000);
  }
  if (keyless == null) fail(`${arm.server} never appeared in listInstalledMcpServers`);
  if (!["initializing", "error"].includes(String(keyless.status))) {
    fail(`with no key stored ${arm.server} reports status=${keyless.status}, expected initializing or error`);
  }
  if (slowest > 5000) fail(`listInstalledMcpServers took ${slowest} ms while the keyless connector was mid-connect`);
  ok(`with no key stored: status=${keyless.status}${keyless.statusDetail ? ` (${keyless.statusDetail})` : ""}, and the list never took longer than ${slowest} ms`);

  armSecrets.push({ server: arm.server, field: arm.field });
  const storedKey = await call("setConnectorSecret", { server: arm.server, field: arm.field, value: KEY });
  if (storedKey?.stored !== true) fail("setConnectorSecret did not report the key stored");
  if (JSON.stringify(storedKey).includes(KEY)) fail("setConnectorSecret echoed the key back");
  ok(`setConnectorSecret stored=${storedKey.stored} restarted=${storedKey.restarted}`);

  let connected = null;
  const connectDeadline = Date.now() + 30_000;
  while (Date.now() < connectDeadline) {
    connected = (await call("listInstalledMcpServers")).find((server) => server.serverIdentifier === arm.server) ?? connected;
    if (connected?.status === "connected") break;
    await sleep(3000);
  }
  if (connected?.status !== "connected") {
    // The keyless window above is also what warms npx, so mcp-remote is normally already downloaded
    // by the time the key lands. A box that cannot reach the npm registry fails here rather than at
    // the credential, and the detail is the only place that says which it was.
    fail(`${arm.server} did not reach connected within 30 s of the key being stored: status=${connected?.status}${connected?.statusDetail ? ` (${connected.statusDetail})` : ""} — if the detail names npx or the registry, this box could not fetch mcp-remote@0.8.3 and the credential path is untested rather than broken`);
  }
  ok(`storing the key restarted the connector and it reached connected, id=${connected.id}`);

  const listed = await waitForServerTools(String(connected.id), 60_000);
  const toolNames = (Array.isArray(listed) ? listed : []).map((tool) => tool.name).sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(["fetch_content", "search"])) {
    fail(`listMcpServerTools for ${arm.server} lists [${toolNames.join(", ")}], expected exactly the stub's fetch_content and search`);
  }
  ok(`listMcpServerTools lists exactly [${toolNames.join(", ")}]`);

  const removedKey = await call("deleteConnectorSecret", { server: arm.server, field: arm.field });
  if (removedKey?.removed !== true) fail("deleteConnectorSecret did not remove the key");
  armSecrets = armSecrets.filter((held) => held.server !== arm.server || held.field !== arm.field);
  const survivors = (await inBox(`grep -rl -- ${KEY} ${DATA} 2>/dev/null || true`)).trim();
  if (survivors.length > 0) fail(`the key survives the delete in: ${survivors}`);
  ok(`the key is gone from ${DATA}`);

  await saveConnectorsThroughRelay(before.mcpServers ?? {});
  await call("refreshMcp", {});
  if ((await call("listInstalledMcpServers")).some((server) => server.serverIdentifier === arm.server)) {
    fail(`${arm.server} survived its removal from connectors.json`);
  }
  await stopStub(stubPath);
  stubPath = null;
  ok("the entry is out of connectors.json and the stub is stopped");

  await assertFilesRestored(armSnapshot, secretsSnapshot);
  armSnapshot = null;
}

/**
 * (k) and (l). A stdio connector whose credential the far end will refuse, for one service.
 *
 * The operator's failure this catches is not a wrong tool list, it is a console that never answers.
 * A dead token has to end somewhere an operator can read: either the connector fails outright, or it
 * connects and the first call comes back saying the credential was refused. What is not allowed is
 * the third outcome -- a connector that stays "initializing" forever while the Plugins panel waits
 * on it, which is exactly what the TinyFish OAuth bridge did.
 */
async function runStdioTokenArm(arm) {
  console.log(`\n${arm.letter} CONNECT-3/4 — ${arm.service}: the pinned package, invented tokens, and a terminal answer`);
  const fields = Object.keys(arm.entry.env);
  const values = Object.fromEntries(fields.map((field) => [field, arm.invent(field)]));
  console.log(`  ${fields.length} invented credential value(s) (never printed), package ${arm.warm}`);

  await refuseIfStored(arm.server, fields);
  armSnapshot = await readConnectorsBase64();
  const secretsSnapshot = await readFileBase64(SECRET_STORE);
  const before = await readConnectorsJson();

  const saved = await saveConnectorsThroughRelay({ ...before.mcpServers, [arm.server]: arm.entry });
  if (!Array.isArray(saved.saved) || !saved.saved.includes(arm.server)) {
    fail(`POST /connectors did not report ${arm.server} saved: ${JSON.stringify(saved).slice(0, 200)}`);
  }
  // No refresh yet, on purpose. Both reads below answer from connectors.json on disk, and a refresh
  // here would spawn the connector once with EMPTY credentials -- so a status this arm read
  // afterwards could be a verdict on the empty value rather than on the invented one it stored.
  const written = (await readConnectorsJson()).mcpServers?.[arm.server];
  if (JSON.stringify(written) !== JSON.stringify(arm.entry)) {
    fail(`connectors.json holds a different entry than the preset: ${JSON.stringify(written).slice(0, 200)}`);
  }
  ok(`the preset entry is in connectors.json unchanged, through the console's POST /connectors`);

  const offered = await call("listConnectorSecretFields", { server: arm.server });
  if (JSON.stringify(offered.fields) !== JSON.stringify([...fields].sort())) {
    fail(`listConnectorSecretFields answers [${(offered.fields ?? []).join(", ")}], expected the entry's empty env values [${[...fields].sort().join(", ")}]`);
  }
  ok(`listConnectorSecretFields offers exactly the entry's ${fields.length} empty env value(s): [${offered.fields.join(", ")}]`);

  for (const field of fields) {
    armSecrets.push({ server: arm.server, field });
    const stored = await call("setConnectorSecret", { server: arm.server, field, value: values[field] });
    if (stored?.stored !== true) fail(`setConnectorSecret did not report ${field} stored`);
    if (JSON.stringify(stored).includes(values[field])) fail(`setConnectorSecret echoed the ${field} value back`);
  }
  ok(`${fields.length} invented value(s) stored through setConnectorSecret`);

  // The connector's FIRST spawn carries the invented tokens, so what the window below measures is
  // this credential and nothing else.
  await call("refreshMcp", {});

  // Ninety seconds for a terminal answer, reading the connector list the whole time so a connector
  // that is still starting cannot be something the console blocks on.
  let row = null;
  let slowest = 0;
  let terminal = null;
  const started = Date.now();
  const deadline = started + 90_000;
  while (Date.now() < deadline) {
    const asked = Date.now();
    const installed = await call("listInstalledMcpServers");
    slowest = Math.max(slowest, Date.now() - asked);
    row = installed.find((server) => server.serverIdentifier === arm.server) ?? row;
    if (row?.status === "error" || row?.status === "connected") { terminal = row.status; break; }
    await sleep(3000);
  }
  if (slowest > 5000) fail(`listInstalledMcpServers took ${slowest} ms while ${arm.server} was starting; the console boots on that list`);
  if (row == null) fail(`${arm.server} never appeared in listInstalledMcpServers`);
  if (terminal == null) {
    fail(`${arm.server} was still status=${row.status}${row.statusDetail ? ` (${row.statusDetail})` : ""} after 90 s: it neither failed nor connected, which is the wait this arm exists to catch`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  ok(`${arm.server} reached a terminal status=${terminal} in ${seconds} s, and the list never took longer than ${slowest} ms`);

  if (terminal === "error") {
    // The honest outcome for a refused credential on a server that authenticates at startup.
    ok(`the invented credential ends as an error an operator can read: ${String(row.statusDetail ?? "(no detail reported)").slice(0, 200)}`);
  } else {
    const listed = await waitForServerTools(String(row.id), 30_000);
    if (!Array.isArray(listed) || listed.length === 0) {
      fail(`${arm.server} reports connected but listed no tools, so there is no first call to make and nothing says the credential was refused`);
    }
    const routed = (await routedTools()).filter((tool) => tool.providerIdentifier === arm.server);
    const chosen = routed.find((tool) => tool.toolName === arm.smoke.tool) ?? routed[0];
    if (chosen == null) fail(`${arm.server} listed ${listed.length} tool(s) but none of them reached listRoutedMcpTools`);
    const isSmoke = chosen.toolName === arm.smoke.tool;
    const outcome = await callRaw("executeRoutedMcpTool", {
      providerIdentifier: arm.server,
      toolName: chosen.name,
      name: chosen.toolName,
      args: isSmoke ? arm.smoke.args : {},
      toolCallId: `verify-connector-plane-${arm.server}-${Date.now()}`,
    });
    const answer = outcome.ok ? JSON.stringify(outcome.value) : outcome.message;
    for (const [field, value] of Object.entries(values)) {
      if (answer.includes(value)) fail(`the ${chosen.toolName} answer carried the ${field} value back`);
    }
    if (!arm.refusal.test(answer)) {
      fail(`the first call to ${chosen.toolName} did not report an authentication failure: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    ok(`connected, and the first call (${chosen.toolName}${isSmoke ? "" : ", the first routed tool"}) reports an authentication failure: ${answer.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  await assertNoneInHostLog(values);

  for (const field of fields) {
    const removed = await call("deleteConnectorSecret", { server: arm.server, field });
    if (removed?.removed !== true) fail(`deleteConnectorSecret did not remove ${field}`);
    armSecrets = armSecrets.filter((held) => held.server !== arm.server || held.field !== field);
  }
  await saveConnectorsThroughRelay(before.mcpServers ?? {});
  await call("refreshMcp", {});
  if ((await call("listInstalledMcpServers")).some((server) => server.serverIdentifier === arm.server)) {
    fail(`${arm.server} survived its removal from connectors.json`);
  }
  ok(`the ${fields.length} credential(s) and the entry are out, and the connector is gone after a refresh`);

  await assertFilesRestored(armSnapshot, secretsSnapshot);
  armSnapshot = null;
}

try {
  console.log(`gateway ${GATEWAY}  box ${BOX}`);
  for (const arm of STDIO_ARMS) if (arm.on) { await warmNpx(arm.warm); console.log(`  --  warming npx ${arm.warm} in the background for ${arm.letter}`); }

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

  if (SKIP_RESTART) console.log(`  --  docker restart skipped (${NO_RESTART ? "--no-restart" : CREDENTIAL_ARM})`);
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

  if (SKIP_MODEL) console.log(`  --  the GetMcpTools leg is skipped (${NO_MODEL ? "--no-model" : CREDENTIAL_ARM})`);
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
      unauthorised = await askStub(PORT, {});
      authorised = await askStub(PORT, { authorization: `Bearer ${KEY}` });
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

  // ---------------------------- (i) (j) CONNECT-3/4 for GitHub and Linear, the other two API keys
  for (const arm of REMOTE_ARMS) {
    if (!arm.on) { console.log(`\n${arm.letter} CONNECT-3/4 — the ${arm.service} arm is skipped (pass ${arm.flag})`); continue; }
    await runRemoteKeyArm(arm);
  }

  // ------------------------------- (k) (l) CONNECT-3/4 for Slack and Google, the stdio packages
  for (const arm of STDIO_ARMS) {
    if (!arm.on) { console.log(`\n${arm.letter} CONNECT-3/4 — the ${arm.service} arm is skipped (pass ${arm.flag})`); continue; }
    await runStdioTokenArm(arm);
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
  //
  // (i) through (l) run after (h) and unwind before it, for the same two reasons: newest write
  // undone first, and every credential deleted while the entry that names its connector is still on
  // disk. A run that failed mid-arm gets here with a live invented value in the store and the
  // entry still installed, which is exactly what these two blocks are for.
  try {
    for (const { server, field } of armSecrets) await callRaw("deleteConnectorSecret", { server, field });
    armSecrets = [];
  } catch (error) { console.error(`cleanup: connector credential — ${error.message}`); }
  try {
    if (armSnapshot != null && await readConnectorsBase64() !== armSnapshot) {
      await restoreConnectorsBase64(armSnapshot);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: connector entry — ${error.message}`); }
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
