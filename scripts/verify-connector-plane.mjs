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
//   CONNECT-5  a shell tool's credential: CodeRabbit ships no MCP server at all, so its key
//              belongs to a COMMAND the agent runs, not to a connector process. The store is the
//              same 0600 file in its own section, and the destination is the environment of the
//              box shell the agent's shell tool spawns. Off by default: --shell-secrets. It does
//              NOT run either installer; the catalog is read, not executed.
//
//   ENV-1 / GATE-11  BOTH shells, in (m) and (m2). The box runs one exec daemon per open desktop
//              window, each with its own environment, and an agent that has a window runs every
//              command through its own. Every probe this gate made went through the PRIMARY
//              daemon, so it stayed green while "Chief of staff" on display :4 read 0 characters
//              from a variable setShellSecret had just reported applied. Both legs now open a
//              probe agent with a window of its own and probe it with `agentId`, and (m2) also
//              holds the submitted value out of the host log. (m) then asks the question a second
//              time with the STORE EMPTIED on disk: a windowed probe re-pushes the whole shell
//              store on its way to the accessor (HostBox.ensureReady), so a probe run against a
//              full store cannot tell the write's fan-out from its own bring-up push.
//
// SECRET-1 gives this gate GATE-8's three exit codes, for GATE-8's reason: (m2) asks a MODEL to
// raise the inline credential card, and a model that does not raise it in time is neither a pass
// nor a failure. Left out of the status, exit 0 would mean two different things.
//
//   0  every leg reached a verdict and every verdict was a pass
//   1  a leg failed
//   3  every leg that reached a verdict passed, and at least one reached none
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
//   node scripts/verify-connector-plane.mjs --shell-secrets   add (m) and (m2), the shell-tool credential
//   node scripts/verify-connector-plane.mjs --plugin-tools    add (n), the agent's plugin tools
//   node scripts/verify-connector-plane.mjs --gh-tool         add (o), git's credential in the box
//              (h) through (o) imply --no-restart and --no-model so each arm fits its budget
//
//   PLUGINTOOLS-1  the agent's four plugin tools against the Marketplace catalog. SearchPlugins,
//              GetPlugin, InstallPlugin and UninstallPlugin used to resolve against Cursor's
//              marketplace, which on this box always answered nothing. This arm asks a probe agent
//              to drive all four in one turn -- that is the only door InstallPlugin has -- and
//              holds the box's connectors.json to what actually happened: the entry appears, then
//              it is gone and the file is byte-identical to what the arm found. Off by default:
//              --plugin-tools. It runs one model turn and needs ~450 s.
//
//   QOL-GH     git in the box, with a credential. Scribe committed inside the box and could not
//              push: `git pull` answered "could not read Username for https://github.com", because
//              git over https with no credential helper has nowhere to get one and prompts into a
//              shell nobody is typing at. The GitHub CLI shell tool's install ends with
//              `gh auth setup-git`, which points git's credential helper at `gh`, and `gh` reads
//              GITHUB_TOKEN out of the same shell environment the secret store already fills. This
//              arm stores an invented GITHUB_TOKEN and then asks git itself: the helper is
//              configured, and `git ls-remote https://github.com/cli/cli-credential-probe` comes
//              back a REFUSAL FROM GITHUB rather than a username prompt or a hang. That path does
//              not exist on purpose: github.com answers 401 for it, which is what makes git ask the
//              helper at all. Off by default:
//              --gh-tool. Like (m) it never runs the installer; if `gh` is not in the box it says
//              so and skips the two legs that need it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const SHELL_SECRETS = process.argv.includes("--shell-secrets");
const PLUGIN_TOOLS = process.argv.includes("--plugin-tools");
const GH_TOOL = process.argv.includes("--gh-tool");
// (h) spends a minute of its own on two deliberate 30 s windows, so on top of the docker restart
// in (a) and the model turn in (b) it does not fit the 280 s these gates are run under. The
// contract names the arm `--tinyfish-key` with no other flags, so the flag carries the two skips.
// (i) through (m) are the same shape and cost the same or more, so they carry them too.
const NO_RESTART = process.argv.includes("--no-restart");
const NO_MODEL = process.argv.includes("--no-model");
const CREDENTIAL_ARM = [
  ["--tinyfish-key", TINYFISH_KEY], ["--github-key", GITHUB_KEY], ["--linear-key", LINEAR_KEY],
  ["--slack-stdio", SLACK_STDIO], ["--google-stdio", GOOGLE_STDIO],
  ["--shell-secrets", SHELL_SECRETS],
  // (n) runs a model turn of its own, so it skips (b)'s for exactly the same budget reason.
  ["--plugin-tools", PLUGIN_TOOLS],
  // QOL-GH: (o) spends its budget on a real network round trip to github.com, so it skips both too.
  ["--gh-tool", GH_TOOL],
].find(([, on]) => on)?.[0];
const SKIP_RESTART = NO_RESTART || CREDENTIAL_ARM != null;
const SKIP_MODEL = NO_MODEL || CREDENTIAL_ARM != null;
// CONNECT-5. The one shell-tool field this arm touches. It refuses to run at all if the host
// already holds a value under it: an operator's real CodeRabbit key is not this gate's to delete.
const SHELL_FIELD = "CODERABBIT_API_KEY";
// QOL-GH. (o)'s field, guarded the same way: an operator's real GitHub token is not this gate's to
// overwrite or delete, so the arm refuses to start if the host already holds one.
const GH_FIELD = "GITHUB_TOKEN";
// SECRET-1. The variable the inline-card leg asks for. Nothing on this box or any other uses this
// name, so the leg cannot collide with an operator's credential; it still refuses to run if the
// host already holds one under it.
const INLINE_FIELD = "VERIFY_INLINE_TOKEN";
// A github.com path that does NOT exist, on purpose. git over https fetches /info/refs anonymously
// first and only consults a credential helper after a 401, so a public repository is read straight
// through and would prove nothing. github.com answers 401 for a path it will not admit to, which
// forces git to ask the helper; what comes back then -- the credential refused, or "Repository not
// found" once one was accepted for transport -- is proof a credential was handed over.
const GH_REMOTE = "https://github.com/cli/cli-credential-probe";
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

/**
 * CONNECT-5. The shell-tool catalog's own ids, read out of the module the host serves them from
 * rather than copied into this file. esbuild bundles the TypeScript the same way tests/ does, so
 * adding or removing a catalog entry moves the expectation with it and never breaks this gate.
 */
async function shellToolCatalogIds() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".shell-catalog-gate-"));
  try {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [path.join(repoRoot, "source/host/extensions/shell-tools/shell-tool-catalog.ts")],
      bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
    });
    const file = path.join(stage, "shell-tool-catalog.cjs");
    writeFileSync(file, result.outputFiles[0].text, "utf8");
    const mod = createRequire(import.meta.url)(file);
    const ids = (mod.SHELL_TOOLS ?? []).map((tool) => String(tool.id));
    if (ids.length === 0) fail("the shell-tool catalog module exports no entries");
    return ids;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 64 << 20 }, (error, out, err) =>
    (error ? reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${err || error.message}`)) : resolve(out))));
const inBox = (script) => docker(["exec", BOX, "sh", "-c", script]);
/**
 * QOL-GH. The same shell with values in its environment, and never a non-zero exit of its own: the
 * arm below wants git's failure TEXT, and `docker exec` turning that into a rejected promise would
 * throw the evidence away. Every script handed to this appends its own `exit 0`.
 *
 * The values passed here are invented by this gate and exist for the length of one arm. They do go
 * on a `docker exec` command line, which the host's process table can see; a real credential would
 * not be passed this way, and this gate never reads one.
 */
const inBoxWithEnv = (env, script) => docker([
  "exec",
  ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
  BOX, "sh", "-c", script,
]);

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

  // Whatever is left of the ninety seconds belongs to the branch below: a connector that says
  // "connected" three seconds in has not necessarily listed or routed a tool yet, and the answer
  // this arm is after is the first call, not the status.
  const left = () => Math.max(deadline - Date.now(), 0);

  if (terminal === "error") {
    // The honest outcome for a refused credential on a server that authenticates at startup. But a
    // spawn, registry or npx failure ends in the same status=error with a detail like "Connection
    // closed", so the detail has to read as a refused credential: without that, this arm would go
    // green on a run that never downloaded the package or reached the credential path at all.
    const detail = String(row.statusDetail ?? "").replace(/\s+/g, " ");
    if (!arm.refusal.test(detail)) {
      fail(`${arm.server} ended status=error, but the detail does not report a refused credential, so nothing in this run exercised the credential path: ${detail.slice(0, 300) || "(no detail reported)"}`);
    }
    ok(`the invented credential ends as an error an operator can read: ${detail.slice(0, 200)}`);
  } else {
    const listed = await waitForServerTools(String(row.id), left());
    if (!Array.isArray(listed) || listed.length === 0) {
      fail(`${arm.server} reports connected but listed no tools within ${Math.round((Date.now() - started) / 1000)} s, so there is no first call to make and nothing says the credential was refused`);
    }
    // Listed is not routed. Wait for the smoke tool to reach the routing table rather than reading
    // it once and calling a lost race a failure; a server that routes something else instead falls
    // through to the first routed tool below, as it always did.
    await waitForRoutedTool(arm.smoke.tool, left());
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
let shellSecretSet = false;
let shellStoreSnapshot = null;
let shellStoreSnapshotTaken = false;
// GATE-11: (m)'s second shell. An agent with its own desktop window runs every command through
// that window's exec daemon, which holds its own environment, so a probe that only ever asked the
// primary daemon proved a shell no agent with a window uses. This agent has one; deleting it
// releases the window, which is why it carries its own unwind.
let shellWindowAgentId = null;
// SECRET-1: the inline-card leg's own unwind. It runs after (m)'s store restore and takes its own
// snapshot, so it carries its own three.
let inlineSecretSet = false;
let inlineStoreSnapshot = null;
let inlineStoreSnapshotTaken = false;
let inlineAgentId = null;
let inlineInconclusive = null;
// PLUGINTOOLS-1 (n). Its own snapshot and its own probe agent, unwound before every earlier arm's
// for the same reason (m) is: the newest write is the one that has to be undone first.
let pluginToolsSnapshot = null;
let pluginToolsAgentId = null;
// QOL-GH (o). The newest arm, so the newest snapshot, so the first one unwound.
let ghSecretSet = false;
let ghStoreSnapshot = null;
let ghStoreSnapshotTaken = false;

// The finally block below is the whole cleanup, and a killed process never reaches it: these arms
// run under `timeout`, which sends SIGTERM. Re-raising after the handler runs keeps the exit status
// honest -- a gate killed by its own budget still reports as killed, it just leaves nothing behind.
const restoreOnSignal = async (signal) => {
  try {
    if (pluginToolsSnapshot != null && await readConnectorsBase64() !== pluginToolsSnapshot) {
      await restoreConnectorsBase64(pluginToolsSnapshot);
      await callRaw("refreshMcp", {});
    }
    if (pluginToolsAgentId != null) await callRaw("deleteAgent", { id: pluginToolsAgentId });
    // QOL-GH: an invented GITHUB_TOKEN left in the store outlives this process, and the next run of
    // (o) would refuse to start because it looks like an operator's key. A kill has to clear it.
    if (ghSecretSet) await callRaw("deleteShellSecret", { field: GH_FIELD });
    if (ghStoreSnapshotTaken) await restoreSecretStoreBase64(ghStoreSnapshot);
  } catch (error) { console.error(`cleanup on ${signal}: ${error.message}`); }
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGTERM", () => { void restoreOnSignal("SIGTERM"); });
process.once("SIGINT", () => { void restoreOnSignal("SIGINT"); });

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

  // ------------------------------------------- (m) CONNECT-5 a shell tool's credential
  if (SHELL_SECRETS) {
    console.log("\n(m) CONNECT-5 — a shell credential in the box shell's environment, and gone again");

    // The catalog is READ, never executed. Running `curl | sh` or `pip install` from a gate would
    // leave a tool on the box that the next run would find already there, and neither installer is
    // what this arm is about.
    const catalogue = await call("listShellTools");
    // What the catalog holds is read out of the catalog MODULE, not written down here. A hardcoded
    // count is a gate that fails the day someone adds an entry, which is what happened when
    // github-cli made "the two catalog entries" three.
    const expected = await shellToolCatalogIds();
    if (!Array.isArray(catalogue)) {
      fail(`listShellTools returned a non-array, expected the ${expected.length} catalog entries`);
    } else {
      const got = catalogue.map((tool) => String(tool?.id)).sort();
      const want = [...expected].sort();
      if (got.join(",") !== want.join(",")) {
        fail(`listShellTools returned [${got.join(", ")}], the catalog holds [${want.join(", ")}]`);
      } else {
        ok(`listShellTools returns every one of the catalog's ${want.length} entries and nothing else`);
      }
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

    // GATE-11. The primary daemon is not the shell an agent with a desktop window runs. This probe
    // agent is given one the way the console gives every agent one -- ensureForeverBox, which is
    // what verify-windows drives -- and every claim below is then made about BOTH shells.
    const windowAgent = await call("createAgent", { name: `verify-window-${Math.random().toString(36).slice(2, 8)}`, description: "", origin: "user", isKickstartRequested: false });
    shellWindowAgentId = windowAgent?.agent?.id ?? windowAgent?.id;
    if (shellWindowAgentId == null) fail("createAgent returned no agent id for the windowed-shell leg");
    const windowStatus = await call("ensureForeverBox", { id: shellWindowAgentId });
    const beforeWindow = await call("probeShellSecret", { field: SHELL_FIELD, agentId: shellWindowAgentId });
    if (beforeWindow?.shell !== `agent:${shellWindowAgentId}`) {
      fail(`probeShellSecret with an agentId answered about ${JSON.stringify(beforeWindow?.shell)}, not that agent's own shell`);
    }
    if (!(Number(beforeWindow?.windowIndex) >= 2)) {
      fail(`the probe agent holds window ${JSON.stringify(beforeWindow?.windowIndex)}, so it shares the primary shell and this leg would prove nothing`);
    }
    if (beforeWindow?.state !== "unset") {
      fail(`the windowed agent's own shell already reports ${SHELL_FIELD} ${beforeWindow?.state}`);
    }
    ok(`a probe agent holds display :${beforeWindow.windowIndex} of its own, and ITS shell reports ${SHELL_FIELD} unset too (box ${windowStatus?.state})`);

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
    if (probedShell?.shell !== "primary") fail(`probeShellSecret without an agentId answered about ${JSON.stringify(probedShell?.shell)}`);
    ok(`the box shell reports ${SHELL_FIELD} set, and says nothing about its value`);

    // ENV-1, the claim the old gate never made: the shell the AGENT runs has it too. Before the
    // fan-out this probe answered "unset" while the one above answered "set", which is exactly
    // what "Chief of staff" measured with `printenv VERIFY_ENV_3 | wc -c` on display :4.
    const probedWindow = await call("probeShellSecret", { field: SHELL_FIELD, agentId: shellWindowAgentId });
    if (probedWindow?.state !== "set") {
      fail(`the windowed agent's own shell (display :${probedWindow?.windowIndex}) reports ${SHELL_FIELD} ${probedWindow?.state} after it was stored`);
    }
    if (JSON.stringify(probedWindow).includes(SHELL_KEY)) fail("the windowed probe answered with the value");
    ok(`and the agent's OWN shell on display :${probedWindow.windowIndex} reports ${SHELL_FIELD} set as well`);

    // GATE-11: the probe above does not isolate the write. probeShellSecret with an agentId goes
    // through HostBox.ensureReady, which re-pushes the ENTIRE shell store into the primary and
    // every open window before it hands back the accessor -- so "the agent's own shell has it"
    // was true whether setShellSecret's fan-out reached display :N or the probe's own bring-up
    // push did. Asked again with the store emptied on disk, the bring-up push carries nothing
    // under this name (an empty update is not pushed at all) and the update is replace:false, so
    // it removes nothing either: the only thing that can have put the value in that window's
    // daemon is the write's own fan-out.
    await restoreSecretStoreBase64(shellStoreSnapshot);
    const isolatedWindow = await call("probeShellSecret", { field: SHELL_FIELD, agentId: shellWindowAgentId });
    if (isolatedWindow?.state !== "set") {
      fail(`with the store emptied, the windowed agent's shell reports ${SHELL_FIELD} ${isolatedWindow?.state}: the probe above was reading its own bring-up push, not setShellSecret's fan-out`);
    }
    const isolatedPrimary = await call("probeShellSecret", { field: SHELL_FIELD });
    if (isolatedPrimary?.state !== "set") {
      fail(`with the store emptied, the primary shell reports ${SHELL_FIELD} ${isolatedPrimary?.state}`);
    }
    ok(`with nothing left in the store to re-push, both shells still hold ${SHELL_FIELD} -- setShellSecret's own push is what put it there`);

    // Put the store back the way the write left it, so the delete below has a field to remove and
    // the byte-identical check at the end still measures this arm and not the isolation step.
    const refilled = await call("setShellSecret", { field: SHELL_FIELD, value: SHELL_KEY });
    if (refilled?.stored !== true) fail("the shell secret store could not be refilled after the isolation check");

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
    const afterWindow = await call("probeShellSecret", { field: SHELL_FIELD, agentId: shellWindowAgentId });
    if (afterWindow?.state !== "unset") fail(`the windowed agent's shell still reports ${SHELL_FIELD} ${afterWindow?.state} after the delete`);
    ok(`after the delete both shells -- the primary and display :${afterWindow.windowIndex} -- report ${SHELL_FIELD} unset again`);

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
    // What this checked, and only that: no copy of the value under sand-data, and a byte-identical
    // store. The delete pushed the field into the live exec daemon as the EMPTY STRING (the control
    // plane can set, it cannot unset), so the name itself outlives this arm in the box shell's
    // environment until the box restarts. That is a name with nothing in it, not a credential.
    ok(`the value is gone from ${DATA} and the store is byte-identical to the file this arm found; ${SHELL_FIELD} stays in the box shell as an empty name until the box restarts`);

    // The window is released by deleting the agent that holds it, which is the only door the
    // console has; verify-windows asserts the same teardown, and it runs after this gate.
    await call("deleteAgents", { ids: [shellWindowAgentId] });
    shellWindowAgentId = null;
    ok("the windowed probe agent is deleted, so its display goes back to the pool");

    // ------------------------------------------------ SECRET-1: the same store, asked for INLINE
    //
    // Everything above this line is the OPERATOR's door: setShellSecret, typed into the console.
    // The ask is the agent's own door -- the masked card it raises mid-conversation, whose value
    // lands as an environment variable of its own box. This leg runs that path end to end and
    // touches no shortcut: the model raises the card, the console's command answers it, and the
    // box's own shell is asked whether it now has the value.
    //
    // It is INCONCLUSIVE, never a failure, when the model does not raise the card in time. What is
    // under test is the route, not the model's willingness to use a tool on the first prompt; a leg
    // that fails on that would be a gate that goes red for the weather.
    console.log("\n(m2) SECRET-1: the agent asks for a credential inline, and it lands in its own shell");

    const inlineHeld = await call("listShellSecretFields");
    if ((inlineHeld?.stored ?? []).includes(INLINE_FIELD)) {
      fail(`the host already holds a ${INLINE_FIELD}; this leg will not overwrite it`);
    }
    inlineStoreSnapshot = await readFileBase64(SECRET_STORE);
    inlineStoreSnapshotTaken = true;

    const inlineBefore = await call("probeShellSecret", { field: INLINE_FIELD });
    if (inlineBefore?.state !== "unset") {
      fail(`the box shell already reports ${INLINE_FIELD} ${inlineBefore?.state}; the check would prove nothing`);
    }
    ok(`before anything is asked for, the box's own shell reports ${INLINE_FIELD} unset`);

    const inlineCreated = await call("createAgent", { name: `verify-secret-${Math.random().toString(36).slice(2, 8)}` });
    inlineAgentId = inlineCreated?.agent?.id ?? inlineCreated?.id;
    if (inlineAgentId == null) fail("createAgent returned no agent id for the inline-card leg");

    // GATE-11: the agent that raises the card gets a desktop window of its own, so the shell this
    // leg then asks is the one that agent's own commands run in -- not the primary daemon, which
    // is the shell no windowed agent ever touches.
    await call("ensureForeverBox", { id: inlineAgentId });
    const inlineWindowBefore = await call("probeShellSecret", { field: INLINE_FIELD, agentId: inlineAgentId });
    if (!(Number(inlineWindowBefore?.windowIndex) >= 2)) {
      fail(`the inline probe agent holds window ${JSON.stringify(inlineWindowBefore?.windowIndex)}, so its shell is the primary one and this leg would prove nothing`);
    }
    if (inlineWindowBefore?.state !== "unset") {
      fail(`the inline agent's own shell already reports ${INLINE_FIELD} ${inlineWindowBefore?.state}`);
    }
    ok(`the inline probe agent holds display :${inlineWindowBefore.windowIndex}, and ITS shell reports ${INLINE_FIELD} unset`);

    await call("sendPrompt", {
      agentId: inlineAgentId,
      prompt: [
        "Ask me for a credential using the secure masked card, and do nothing else this turn.",
        'Call SendMessage once with type "secret-request" and secret set to exactly:',
        '{ "label": "Verify inline token", "description": "A throwaway value for a verification gate. Never share it in chat.",',
        `  "connector": "shell", "field": "${INLINE_FIELD}" }`,
        "Send no other message and call no other tool.",
      ].join("\n"),
    });

    // The card is a transcript entry, so the transcript is where it is waited for -- the same
    // surface the console reads and the same entry id submitSecret takes.
    const inlineDeadline = Date.now() + 120_000;
    let inlineEntry = null;
    while (Date.now() < inlineDeadline) {
      await sleep(5000);
      const transcript = await call("getAgentTranscript", { id: inlineAgentId }).catch(() => []);
      inlineEntry = (Array.isArray(transcript) ? transcript : []).find((entry) =>
        entry.kind === "send-message" && entry.message?.type === "secret-request") ?? null;
      if (inlineEntry != null) break;
    }

    if (inlineEntry == null) {
      inlineInconclusive = `the model did not raise a secret-request card within 120 s, so the route was never exercised from its own end (the operator-door legs above still passed)`;
      console.log(`  --  INCONCLUSIVE: ${inlineInconclusive}`);
      console.log(`  --  nothing was stored and nothing was submitted; the leg unwinds as if it had run.`);
    } else {
      const asked = inlineEntry.message.secretRequest ?? {};
      const askedTarget = asked.target ?? {};
      if (String(askedTarget.platform ?? "").toLowerCase() !== "shell") {
        fail(`the card names connector ${JSON.stringify(askedTarget.platform)}, not "shell"; the shell route was not the one asked for`);
      }
      if (askedTarget.field !== INLINE_FIELD) {
        fail(`the card asks for field ${JSON.stringify(askedTarget.field)}, not ${INLINE_FIELD}`);
      }
      ok(`the agent raised a masked card: "${asked.label}" -> connector shell, field ${askedTarget.field}`);

      // Invented here and nowhere else. It is not a credential to anything.
      const INLINE_VALUE = `inline-verify-${Math.random().toString(36).slice(2, 14)}`;
      const inlineDigest = createHash("sha256").update(INLINE_VALUE).digest("hex");
      console.log(`  probe value: ${INLINE_VALUE.length} characters (never printed)`);

      await call("submitSecret", { entryId: inlineEntry.id, value: INLINE_VALUE, agentId: inlineAgentId });
      inlineSecretSet = true;

      // The host's own stamp, not this script's optimism: secretProvided on the entry is what the
      // console reads to collapse the card, and it is only set once routeSecret returned a
      // destination.
      const stampDeadline = Date.now() + 60_000;
      let inlineStamped = false;
      while (Date.now() < stampDeadline) {
        const transcript = await call("getAgentTranscript", { id: inlineAgentId }).catch(() => []);
        const entry = (Array.isArray(transcript) ? transcript : []).find((item) => item.id === inlineEntry.id);
        if (entry?.secretProvided === true) { inlineStamped = true; break; }
        await sleep(3000);
      }
      if (!inlineStamped) fail("the host never stamped secretProvided on the card, so nothing was routed");
      ok("the host stamped the card provided, which it only does once the value reached a destination");

      // Two claims, asked of two different places. The box's own shell says the NAME is set -- the
      // same question (m) asks of setShellSecret -- and the store's digest says it is the same
      // VALUE that was submitted. Neither prints it.
      const inlineProbed = await call("probeShellSecret", { field: INLINE_FIELD });
      if (inlineProbed?.state !== "set") {
        fail(`the box shell reports ${INLINE_FIELD} ${inlineProbed?.state} after the card was answered`);
      }
      if (JSON.stringify(inlineProbed).includes(INLINE_VALUE)) fail("probeShellSecret answered with the value");
      // The shell the asking agent actually runs in. This is the leg the fan-out exists for: the
      // agent asked for a variable its own commands would read, and this is the only probe that
      // says whether they can.
      const inlineWindowProbed = await call("probeShellSecret", { field: INLINE_FIELD, agentId: inlineAgentId });
      if (inlineWindowProbed?.state !== "set") {
        fail(`the asking agent's own shell (display :${inlineWindowProbed?.windowIndex}) reports ${INLINE_FIELD} ${inlineWindowProbed?.state} after the card was answered`);
      }
      if (JSON.stringify(inlineWindowProbed).includes(INLINE_VALUE)) fail("the windowed probe answered with the value");
      const storedDigest = (await docker(["exec", BOX, "node", "-e",
        `const v=(JSON.parse(require('fs').readFileSync(${JSON.stringify(SECRET_STORE)},'utf8')).shell||{})[${JSON.stringify(INLINE_FIELD)}];process.stdout.write(v==null?'absent':require('crypto').createHash('sha256').update(v).digest('hex'))`,
      ])).trim();
      if (storedDigest !== inlineDigest) {
        fail(`the store holds ${storedDigest === "absent" ? "nothing" : "a different value"} under ${INLINE_FIELD}: sha256 ${storedDigest.slice(0, 16)}… against the submitted ${inlineDigest.slice(0, 16)}…`);
      }
      ok(`both shells -- the primary and the asking agent's display :${inlineWindowProbed.windowIndex} -- report ${INLINE_FIELD} set, and the store's sha256 matches the value submitted through the card (${inlineDigest.slice(0, 16)}…)`);

      // The ack the model was resumed with has to name the variable. It is a hidden prompt, so the
      // transcript is not where it shows; what this can check is that the value is in no entry.
      const finalTranscript = await call("getAgentTranscript", { id: inlineAgentId }).catch(() => []);
      if (JSON.stringify(finalTranscript).includes(INLINE_VALUE)) {
        fail("the submitted value is somewhere in the agent's transcript");
      }
      // The check (m) makes of the operator door and this leg did not: a value that reached the
      // host log is a value in a file the agent can read and an operator can page through. The
      // route runs through three modules that log (the sink, routeSecret, the box push), so it is
      // asked of the log itself rather than reasoned about.
      const inlineLogHit = (await inBox(`grep -c -- ${INLINE_VALUE} /tmp/sand-host.log 2>/dev/null | head -1`)).trim();
      if (inlineLogHit !== "" && inlineLogHit !== "0") fail(`the host log contains the submitted value ${inlineLogHit} time(s)`);
      ok("and the value is in no transcript entry of the agent that asked for it, and in no line of the host log");

      const inlineRemoved = await call("deleteShellSecret", { field: INLINE_FIELD });
      inlineSecretSet = inlineRemoved?.removed !== true;
      if (inlineRemoved?.removed !== true) fail("deleteShellSecret did not remove the inline field");
      const inlineAfter = await call("probeShellSecret", { field: INLINE_FIELD });
      if (inlineAfter?.state !== "unset") fail(`the box shell still reports ${INLINE_FIELD} ${inlineAfter?.state} after the delete`);

      const inlineSurvivors = (await inBox(`grep -rl -- ${INLINE_VALUE} ${DATA} 2>/dev/null || true`)).trim();
      if (inlineSurvivors.length > 0) fail(`the value survives the delete in: ${inlineSurvivors}`);
      ok(`after the delete the box shell reports ${INLINE_FIELD} unset and no file under ${DATA} holds the value`);
    }

    await restoreSecretStoreBase64(inlineStoreSnapshot);
    const inlineStoreNow = await readFileBase64(SECRET_STORE);
    if (inlineStoreNow !== inlineStoreSnapshot) {
      fail("connector-env-secrets.json is not byte-identical to what the inline-card leg found");
    }
    inlineStoreSnapshotTaken = false;
    await call("deleteAgent", { id: inlineAgentId });
    inlineAgentId = null;
    ok("the probe agent is deleted and the secret store is byte-identical to the file this leg found");
  }

  // ---------------------------------- (n) PLUGINTOOLS-1 the agent's four tools on the catalog
  if (PLUGIN_TOOLS) {
    console.log("\n(n) PLUGINTOOLS-1 — SearchPlugins, GetPlugin, InstallPlugin and UninstallPlugin on the Marketplace catalog");

    // The catalog through the gateway first, because it is what the console reads and what the
    // four tools resolve against. A read, so it can never leave anything behind.
    const marketplace = await call("listMarketplace");
    const plugins = marketplace?.plugins ?? [];
    const bots = marketplace?.bots ?? [];
    if (!Array.isArray(plugins) || plugins.length === 0) fail("listMarketplace returned no plugins");
    if (!Array.isArray(bots) || bots.length === 0) fail("listMarketplace returned no bots");
    if (!Array.isArray(marketplace?.categories?.plugins) || !Array.isArray(marketplace?.categories?.bots)) {
      fail("listMarketplace returned no category lists");
    }
    ok(`listMarketplace: ${plugins.length} plugin(s), ${bots.length} bot(s), ${marketplace.categories.plugins.length}/${marketplace.categories.bots.length} categories`);

    const item = await call("getMarketplaceItem", { kind: "plugin", id: TINYFISH_SERVER });
    if (item?.id !== TINYFISH_SERVER) fail(`getMarketplaceItem answered ${JSON.stringify(item?.id)}`);
    if (item?.install?.env?.[TINYFISH_FIELD] !== "") {
      fail(`the ${TINYFISH_SERVER} entry does not leave ${TINYFISH_FIELD} empty, so the host would not read it as a credential`);
    }
    for (const [name, entry] of Object.entries(item.install.env)) {
      if (entry !== "") fail(`the ${TINYFISH_SERVER} entry gives env ${name} a value; a catalog carries no values`);
    }
    ok(`getMarketplaceItem: ${item.name} (${item.kind}) declares ${TINYFISH_FIELD} empty and carries no value`);

    const badKind = await callRaw("getMarketplaceItem", { kind: "provider", id: "anything" });
    if (badKind.ok) fail("getMarketplaceItem accepted a kind that is not plugin or bot");
    ok("getMarketplaceItem refuses a kind it does not serve");

    // The plugin the model will install: the first connector in the catalog this box does NOT
    // already have. Installing over a connector the operator configured would be this gate
    // editing their box, and "byte-identical after" would then be a claim about the wrong file.
    pluginToolsSnapshot = await readConnectorsBase64();
    const installedNames = new Set(Object.keys((await readConnectorsJson()).mcpServers ?? {}));
    const target = plugins.find((plugin) =>
      plugin.kind === "connector" && plugin.install != null && plugin.connectorName != null
      && !installedNames.has(plugin.connectorName));
    if (target == null) fail("every connector in the catalog is already installed on this box; the install leg would prove nothing");
    ok(`the install leg will use ${target.id} (connector "${target.connectorName}"), which this box does not have`);

    const created = await call("createAgent", { name: `verify-plugins-${Math.random().toString(36).slice(2, 8)}` });
    pluginToolsAgentId = created?.agent?.id ?? created?.id;
    if (pluginToolsAgentId == null) fail("createAgent returned no agent id");

    // Two turns rather than one: the install has to be checked against the box BEFORE the
    // uninstall, or an install that no-opped and an uninstall that no-opped would leave the file
    // byte-identical and prove nothing. The yes is given in the prompt because these tools ask for
    // a confirmation widget before a mutation, and a widget would end the turn with nothing done.
    const PLUGIN_TURN_MS = 170_000;
    const NO_ASK = "This is a supervised verification run and I have already agreed to everything below, so do NOT send a question widget and do NOT ask me anything.";
    if (!await runTurn(pluginToolsAgentId, [
      NO_ASK,
      "In this one turn, in this order:",
      `1. Call SearchPlugins with the query "${target.name}".`,
      `2. Call GetPlugin with the plugin id "${target.id}".`,
      `3. Call InstallPlugin with the plugin id "${target.id}". Do not pass any values.`,
      "Then reply with one short line naming the credential field GetPlugin listed. Call no other tool.",
    ].join("\n"), PLUGIN_TURN_MS)) fail("the probe agent's install turn did not settle inside its budget");

    // The action ledger is the only surface carrying a tool's NAME beside its answer, so it is what
    // says which tool actually ran and what each one said.
    const answers = {};
    const readAnswers = async (names) => {
      for (const name of names) {
        const results = await toolResults(pluginToolsAgentId, name);
        if (results.length === 0) fail(`the probe agent never called ${name}`);
        answers[name] = String(results.at(-1).head ?? "");
        console.log(`  ${name}: ${answers[name].replace(/\s+/g, " ").slice(0, 220)}`);
      }
    };
    await readAnswers(["SearchPlugins", "GetPlugin", "InstallPlugin"]);
    if (!new RegExp(`\\b${target.id}\\b`).test(answers.SearchPlugins)) {
      fail(`SearchPlugins did not list ${target.id}; the catalog did not reach the model`);
    }
    if (/empty or unavailable/.test(answers.SearchPlugins)) fail("SearchPlugins still reports an unreachable catalog");
    ok(`SearchPlugins lists the catalog and names ${target.id}`);

    const field = Object.keys(target.credentialHints ?? {})[0];
    if (field != null && !new RegExp(`\\b${field}\\b`).test(answers.GetPlugin)) {
      fail(`GetPlugin did not name ${target.id}'s credential field ${field}`);
    }
    ok(`GetPlugin returns ${target.id}${field == null ? "" : ` with its field ${field}`}`);

    // What the install actually did to the box, not what the model said about it. The entry has
    // to have BEEN there: an install and an uninstall that both no-opped would leave the file
    // byte-identical too, and would prove nothing at all.
    if (!/Installed /.test(answers.InstallPlugin)) fail(`InstallPlugin did not report an install: ${answers.InstallPlugin.slice(0, 300)}`);
    if (field != null && !new RegExp(`\\b${field}\\b`).test(answers.InstallPlugin)) {
      fail(`InstallPlugin did not name the field the operator must fill (${field})`);
    }
    const writtenEntry = (await readConnectorsJson()).mcpServers?.[target.connectorName];
    if (writtenEntry == null) fail(`InstallPlugin reported success but ${target.connectorName} is not in connectors.json`);
    if (JSON.stringify(writtenEntry) !== JSON.stringify(target.install)) {
      fail(`the entry written for ${target.connectorName} is not the catalog's entry`);
    }
    for (const [name, value] of Object.entries(writtenEntry.env ?? {})) {
      if (value !== "") fail(`the written entry gives env ${name} a value; every credential must land empty`);
    }
    ok(`InstallPlugin wrote the catalog's entry for ${target.connectorName} with its credential field${field == null ? "" : ` ${field}`} empty`);

    if (!await runTurn(pluginToolsAgentId,
      `${NO_ASK}\nCall UninstallPlugin once with the plugin id "${target.id}", then reply with its exact output text. Call no other tool.`,
      PLUGIN_TURN_MS)) fail("the probe agent's uninstall turn did not settle inside its budget");
    await readAnswers(["UninstallPlugin"]);
    if (!/Uninstalled /.test(answers.UninstallPlugin)) fail(`UninstallPlugin did not report a removal: ${answers.UninstallPlugin.slice(0, 300)}`);
    if (Object.hasOwn((await readConnectorsJson()).mcpServers ?? {}, target.connectorName)) {
      fail(`${target.connectorName} is still in connectors.json after UninstallPlugin`);
    }
    const afterPluginTools = await readConnectorsBase64();
    if (afterPluginTools !== pluginToolsSnapshot) {
      await restoreConnectorsBase64(pluginToolsSnapshot);
      await callRaw("refreshMcp", {});
      fail("connectors.json is not byte-identical to what this arm found; it has been put back");
    }
    pluginToolsSnapshot = null;
    ok(`UninstallPlugin removed ${target.connectorName} and connectors.json is byte-identical to before the arm`);

    await call("deleteAgent", { id: pluginToolsAgentId });
    pluginToolsAgentId = null;
    ok("the probe agent is deleted");
  }

  // ------------------------------- (o) QOL-GH git in the box, with a credential instead of a prompt
  if (GH_TOOL) {
    console.log("\n(o) QOL-GH — GITHUB_TOKEN in the box shell, and git authenticating instead of prompting");

    // The catalog is READ, never executed, for the same reason (m) reads it: this install adds an
    // apt repository or drops a binary in ~/.local/bin, and neither is a gate's to do on a shared
    // box. What is checked here is that the entry ends by giving GIT a credential helper -- an
    // install that stopped at `gh --version` would leave the bug exactly where it was found.
    const ghCatalogue = await call("listShellTools");
    const ghEntry = Array.isArray(ghCatalogue) ? ghCatalogue.find((tool) => tool.id === "github-cli") : null;
    if (ghEntry == null) fail(`listShellTools carries no github-cli entry; it has ${(ghCatalogue ?? []).map((tool) => tool.id).join(", ") || "nothing"}`);
    if (ghEntry.field !== GH_FIELD) fail(`the github-cli entry's field is ${ghEntry.field}, expected ${GH_FIELD}`);
    if (!/gh auth setup-git/.test(String(ghEntry.install))) fail("the github-cli install never runs `gh auth setup-git`, so git would still have no credential helper");
    if (!/cli\.github\.com\/packages/.test(String(ghEntry.install))) fail("the github-cli install does not use the documented apt repository");
    if (String(ghEntry.install).includes("$GITHUB_TOKEN")) fail("the github-cli install puts the token on a command line");
    ok(`the catalog carries github-cli (${ghEntry.field}, binary gh) and its install ends in gh auth setup-git — the installer is not run here`);

    const ghHeld = await call("listShellSecretFields");
    if ((ghHeld?.stored ?? []).includes(GH_FIELD)) {
      fail(`the host already holds a ${GH_FIELD}; this arm will not overwrite an operator's token`);
    }
    if (!(ghHeld?.fields ?? []).includes(GH_FIELD)) fail(`listShellSecretFields does not offer ${GH_FIELD}`);
    ghStoreSnapshot = await readFileBase64(SECRET_STORE);
    ghStoreSnapshotTaken = true;

    const ghBefore = await call("probeShellSecret", { field: GH_FIELD });
    if (ghBefore?.state !== "unset") fail(`the box shell already reports ${GH_FIELD} ${ghBefore?.state}; the check would prove nothing`);
    ok(`before anything is stored, the box's own shell reports ${GH_FIELD} unset`);

    // Invented here and nowhere else. It is deliberately shaped like a GitHub token and is not one:
    // the whole point of the ls-remote below is that GitHub REFUSES it.
    const GH_KEY = `ghp_verify${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
    console.log(`  probe value: ${GH_KEY.length} characters (never printed)`);
    const ghStored = await call("setShellSecret", { field: GH_FIELD, value: GH_KEY });
    ghSecretSet = true;
    if (ghStored?.stored !== true) fail("setShellSecret did not report the token stored");
    if (ghStored?.applied !== true) fail("setShellSecret stored the token but did not push it into the live box");
    if (JSON.stringify(ghStored).includes(GH_KEY)) fail("setShellSecret echoed the token back");
    const ghProbed = await call("probeShellSecret", { field: GH_FIELD });
    if (ghProbed?.state !== "set") fail(`the box shell reports ${GH_FIELD} ${ghProbed?.state} after it was stored`);
    if (JSON.stringify(ghProbed).includes(GH_KEY)) fail("probeShellSecret answered with the token");
    ok(`setShellSecret stored=true applied=true, and the box's own shell now reports ${GH_FIELD} set`);

    // `gh` is a program, and nothing records that it was installed, so the box's shell is the only
    // authority -- the same claim probeShellToolBinary makes. `-lc` from home is what puts
    // ~/.local/bin on PATH, which is where the tarball route lands the binary.
    const ghWhich = (await inBox('sh -lc \'PATH="$HOME/.local/bin:$PATH"; command -v gh\' 2>/dev/null || true')).trim();
    const gitWhich = (await inBox("command -v git 2>/dev/null || true")).trim();
    if (gitWhich.length === 0) fail("this box has no git at all, so there is nothing for a credential helper to serve");
    if (ghWhich.length === 0) {
      console.log(`  --  gh is not installed in this box, so the credential-helper and ls-remote legs are SKIPPED.`);
      console.log(`  --  this gate never runs the installer (${ghEntry.install.split("\n").length} lines, an apt repository or a release tarball).`);
      console.log(`  --  install it from the console: Marketplace -> Plugins -> GitHub CLI (gh) -> Install in the box,`);
      console.log(`      or through the gateway: curl -sS -X POST -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"id":"github-cli"}' ${GATEWAY}/api/installShellTool`);
    } else {
      ok(`the box's shell finds gh at ${ghWhich}`);

      // Which HOME carries the config is not something this script can assume: the installer runs
      // as whoever the host runs as, and `docker exec` need not be that user. So the answer is
      // looked for where it can be, and the one that has it is named in the output rather than
      // guessed at. `git config --global` reads $HOME/.gitconfig, so HOME is the whole question.
      const ghDefaultHome = (await inBox('printf %s "$HOME"')).trim() || "/root";
      const ghHomes = [...new Set([ghDefaultHome, "/home/box", "/root"])];
      let ghHome = null;
      let ghHelper = "";
      for (const home of ghHomes) {
        const found = (await inBox(`HOME=${home} git config --global --get-regexp '^credential\\..*helper$' 2>/dev/null || true`)).trim();
        if (/gh auth git-credential/.test(found)) { ghHome = home; ghHelper = found; break; }
      }
      if (ghHome == null) {
        fail(`no global git config under ${ghHomes.join(", ")} names gh as a credential helper; `
          + "`gh auth setup-git` has not run in this box, so git over https still has nowhere to get a username");
      }
      // The helper is URL-scoped, the shape `gh auth setup-git` writes: credential.https://github.com.helper.
      if (!/^credential\.https:\/\/github\.com\.helper /m.test(ghHelper)) {
        fail(`the credential helper is configured under an unexpected key: ${ghHelper.replace(/\n/g, " | ")}`);
      }
      ok(`HOME=${ghHome} carries ${ghHelper.split("\n").filter((line) => /gh auth git-credential/.test(line)).join(" | ")}`);

      // The claim the whole arm exists for. GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=/bin/false mean
      // git CANNOT prompt or block on a tty: with no helper this comes back "could not read
      // Username for 'https://github.com': terminal prompts disabled" in well under a second, which
      // is precisely the failure scribe hit. A pass is the other answer -- github.com answering on
      // a credential the helper handed over, which for a path that does not exist is either an
      // authentication failure or "Repository not found"; both mean git got past the 401 with
      // something in hand.
      const ghRun = await inBoxWithEnv({ GITHUB_TOKEN: GH_KEY }, [
        `export HOME=${ghHome}`,
        'export PATH="$HOME/.local/bin:$PATH"',
        "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false",
        'TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout 60"',
        `out=$($TO git ls-remote ${GH_REMOTE} 2>&1); status=$?`,
        `printf '%s\\n' "$out" | tail -n 8`,
        'echo "gh-gate-exit:$status"',
        "exit 0",
      ].join("\n"));
      const ghStatus = Number(/gh-gate-exit:(\d+)/.exec(ghRun)?.[1] ?? "-1");
      // The invented token must not reach a log: it is struck from what this gate prints.
      const ghText = ghRun.split(GH_KEY).join("[redacted]").replace(/gh-gate-exit:\d+\n?/, "").trim();
      console.log(ghText.split("\n").map((line) => `      ${line}`).join("\n") || "      (no output)");
      if (/could not read Username|terminal prompts disabled|Authentication prompt|askpass|unable to (get|read) (password|username)/i.test(ghText)) {
        fail(`git asked for a username instead of using the helper: ${ghText.replace(/\n/g, " | ")}`);
      }
      if (ghStatus === 124 || ghStatus === 137) fail(`git ls-remote hung and was killed after 60 s (exit ${ghStatus})`);
      if (!/Authentication failed|Invalid username or (token|password)|invalid credentials|Bad credentials|HTTP (401|403)|403 Forbidden|401 Unauthorized|Repository not found|repository '[^']*' not found/i.test(ghText)) {
        fail(`git ls-remote ${GH_REMOTE} exited ${ghStatus}, but github.com did not answer on a credential: ${ghText.replace(/\n/g, " | ")}`);
      }
      ok(`git ls-remote ${GH_REMOTE} came back on the credential the helper handed over (exit ${ghStatus}) — nothing prompted`);
    }

    // Same custody claim (m) makes, for the store this arm filled: one file holds the value, 0600,
    // and the host log does not. `gh` itself never writes the token anywhere -- it reads it out of
    // the environment on each call -- so a hit outside the store would be a real leak.
    const ghHits = (await inBox(`grep -rl -- ${GH_KEY} ${DATA} 2>/dev/null || true`))
      .split("\n").map((line) => line.trim()).filter(Boolean);
    if (ghHits.length !== 1 || !ghHits[0].endsWith("/connector-env-secrets.json")) {
      fail(`the token is in ${ghHits.length} file(s) under ${DATA}; expected only connector-env-secrets.json`);
    }
    const ghLogHit = (await inBox(`grep -c -- ${GH_KEY} /tmp/sand-host.log 2>/dev/null | head -1`)).trim();
    if (ghLogHit !== "" && ghLogHit !== "0") fail(`the host log contains the token ${ghLogHit} time(s)`);
    ok(`only ${ghHits[0]} holds it, and the host log does not`);

    const ghRemoved = await call("deleteShellSecret", { field: GH_FIELD });
    ghSecretSet = ghRemoved?.removed !== true;
    if (ghRemoved?.removed !== true) fail("deleteShellSecret did not remove the token");
    if ((ghRemoved?.stored ?? []).includes(GH_FIELD)) fail("the store still lists the field after the delete");
    const ghAfter = await call("probeShellSecret", { field: GH_FIELD });
    if (ghAfter?.state !== "unset") fail(`the box shell still reports ${GH_FIELD} ${ghAfter?.state} after the delete`);
    const ghSurvivors = (await inBox(`grep -rl -- ${GH_KEY} ${DATA} 2>/dev/null || true`)).trim();
    if (ghSurvivors.length > 0) fail(`the token survives the delete in: ${ghSurvivors}`);
    await restoreSecretStoreBase64(ghStoreSnapshot);
    const ghStoreNow = await readFileBase64(SECRET_STORE);
    if (ghStoreNow !== ghStoreSnapshot) {
      fail(`connector-env-secrets.json is not byte-identical to what this arm found (${ghStoreSnapshot == null ? "it did not exist" : "it existed"} before, ${ghStoreNow == null ? "it does not exist" : "it exists"} now)`);
    }
    ghStoreSnapshotTaken = false;
    // What is NOT undone, said out loud: the git credential helper this arm read is the box's own
    // configuration and was never written here, and the delete pushes GITHUB_TOKEN into the live
    // exec daemon as the EMPTY STRING because the control plane can set but not unset. An empty
    // name is not a credential, and a box restart drops it.
    ok(`the token is gone from ${DATA} and the store is byte-identical; ${GH_FIELD} stays in the box shell as an empty name until the box restarts`);
  }

  // SECRET-1: an inconclusive leg is a PASS with the reason on the last line, and it takes GATE-8's
  // exit code rather than 0. A green connector plane must not mean two different things.
  if (inlineInconclusive != null) {
    console.log("\nPASS — connector plane");
    console.log(`  one INCONCLUSIVE leg: ${inlineInconclusive}`);
    process.exitCode = 3;
  } else console.log("\nPASS — connector plane");
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
  // CONNECT-5: (m) unwinds before (h) for the same reason (h) unwinds before (c) -- the later arm
  // took the later snapshot, so the later arm's restore has to be overwritten by nobody.
  // PLUGINTOOLS-1: (n) is the newest arm and took the newest snapshot, so it unwinds before (m).
  // QOL-GH: (o) is newer still, and it snapshots the same secret store (m) does, so it goes first.
  try {
    if (ghSecretSet) await callRaw("deleteShellSecret", { field: GH_FIELD });
  } catch (error) { console.error(`cleanup: gh token — ${error.message}`); }
  try {
    if (ghStoreSnapshotTaken) await restoreSecretStoreBase64(ghStoreSnapshot);
  } catch (error) { console.error(`cleanup: secret store after (o) — ${error.message}`); }
  try {
    if (pluginToolsSnapshot != null && await readConnectorsBase64() !== pluginToolsSnapshot) {
      await restoreConnectorsBase64(pluginToolsSnapshot);
      await callRaw("refreshMcp", {});
    }
  } catch (error) { console.error(`cleanup: plugin-tools connector entry — ${error.message}`); }
  try {
    if (pluginToolsAgentId != null) await callRaw("deleteAgent", { id: pluginToolsAgentId });
  } catch (error) { console.error(`cleanup: plugin-tools probe agent — ${error.message}`); }
  // SECRET-1: the inline-card leg is the newest write inside (m), so it unwinds before (m)'s own.
  try {
    if (inlineSecretSet) await callRaw("deleteShellSecret", { field: INLINE_FIELD });
  } catch (error) { console.error(`cleanup: inline shell secret: ${error.message}`); }
  try {
    if (inlineStoreSnapshotTaken) await restoreSecretStoreBase64(inlineStoreSnapshot);
  } catch (error) { console.error(`cleanup: secret store after the inline-card leg: ${error.message}`); }
  try {
    if (inlineAgentId != null) await callRaw("deleteAgent", { id: inlineAgentId });
  } catch (error) { console.error(`cleanup: inline-card probe agent: ${error.message}`); }
  try {
    if (shellSecretSet) await callRaw("deleteShellSecret", { field: SHELL_FIELD });
  } catch (error) { console.error(`cleanup: shell secret — ${error.message}`); }
  // GATE-11: the windowed probe agent holds a display until it is deleted, so a run that died
  // mid-leg must not leave one up. verify-windows fails on exactly that.
  try {
    if (shellWindowAgentId != null) await callRaw("deleteAgents", { ids: [shellWindowAgentId] });
  } catch (error) { console.error(`cleanup: windowed probe agent: ${error.message}`); }
  try {
    if (shellStoreSnapshotTaken) await restoreSecretStoreBase64(shellStoreSnapshot);
  } catch (error) { console.error(`cleanup: secret store — ${error.message}`); }
  //
  // (i) through (l) also run after (h) and unwind before it, for the same two reasons: newest write
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
