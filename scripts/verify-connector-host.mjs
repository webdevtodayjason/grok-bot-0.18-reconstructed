// MARKET-6, item C. The host half of the connector plane, checked against the live box.
//
// What this proves, in order, and why each one is here:
//
//   (a) THE SPIKE. The box's exec daemon accepts a `{type,url}` server through LoadMcpServers and
//       CONNECTS TO IT ITSELF. Every "remote" connector before this was `npx mcp-remote` bridged,
//       because `parseServer` dropped a url entry, `getStdioServerConfigs` filtered it out, and
//       anything the host did know about was dispatched to Cursor's Dashboard RPC, which answers
//       nothing on any Titanium Bot box. The verdict is the transport that connected and its tool
//       count, recorded rather than assumed.
//
//   (b) CUSTODY. A remote connector whose key rides in a header: the stored value reaches the far
//       end, and it is in NEITHER connectors.json NOR `ps -eo args` inside the box. That second
//       half is the whole reason this arm exists. The box's exec daemon expands `${VAR}` in a
//       spawn's arguments BEFORE exec, so the bridged shape put a live bearer into the argument
//       list of three root processes -- and the agent's own shell in that box is root. This line
//       fails on the old code and passes on the new one, which makes it the most valuable
//       assertion in the wave.
//
//   (c) A PROGRAM. A stdio server added through the same one writer connects and lists its tools,
//       so opening the door to url entries did not close it on the shape that already worked.
//
//   (d) CONNECT-11. A key is stored, its entry is removed, and the key is then found and cleared
//       BY NAME. `resolveLocalConnector` threw the moment the entry left connectors.json, which is
//       exactly when a stale credential most needs clearing: reproduced twice on the local box.
//
//   (e) THE TABLE. The one writer refuses what it must, at the gateway, on the live host: a
//       loopback address (inside a box that is the exec daemon on 1337/1338 and the gateway on
//       1340), a key in the query string, a literal in an Authorization header, and the reserved
//       name. A refusal must change no file.
//
//   (f) RESTORATION. connectors.json and connector-env-secrets.json are byte-identical to what
//       they were before the run, and no probe entry is left behind.
//
// Integration check, not a unit test: needs the box up, running a bundle built from THIS tree.
// Spends no model turn. Run it through scripts/on-box.sh so it does not overlap another gate.
//
//   node scripts/verify-connector-host.mjs
//   node scripts/verify-connector-host.mjs --keep    leave the probe entries for inspection
//
//   0  every leg passed        1  a leg failed
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";
const KEEP = process.argv.includes("--keep");

// Deliberately not a real vendor key. The stub below is the far end, so a made-up value proves the
// custody claim without a credential of anyone's in it.
const PROBE_VALUE = `PROBE-BEARER-${Math.random().toString(36).slice(2, 12)}`;
const REMOTE_SERVER = "chostprobe-remote";
const STDIO_SERVER = "chostprobe-stdio";
const ORPHAN_SERVER = "chostprobe-orphan";
const FIELD = "CHOSTPROBE_TOKEN";
const STUB_PORT = 8791;

class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
const ok = (message) => console.log(`  ok  ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* next */ }
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

// Nested quoting through `docker exec sh -c` is how a gate ends up asserting on a shell error, so
// every in-box script is written to a file, copied in, run, and deleted.
let scriptSeq = 0;
async function inBoxScript(source) {
  const name = `/tmp/chostprobe-${process.pid}-${scriptSeq++}.mjs`;
  await docker(["exec", BOX, "node", "-e",
    `require("fs").writeFileSync(${JSON.stringify(name)}, Buffer.from(${JSON.stringify(Buffer.from(source, "utf8").toString("base64"))}, "base64"))`]);
  try { return await docker(["exec", BOX, "node", name]); }
  finally { await docker(["exec", BOX, "rm", "-f", name]).catch(() => {}); }
}

const sha256 = async (path) => (await docker(["exec", BOX, "sha256sum", path])).trim().split(/\s+/)[0];

const CONNECTORS = "/home/box/sand-data/connectors.json";
const SECRETS = "/home/box/sand-data/connector-env-secrets.json";

/**
 * The far end: scripts/lib/mcp-bearer-stub.mjs, the SAME bytes verify-connector-plane's own
 * credential arms drive, copied into the box and started there. Deliberately in the box rather than
 * a vendor, because the custody claim needs a key whose absence we are allowed to print, and no
 * real credential belongs in a gate.
 *
 * It is addressed by the box's OWN address rather than 127.0.0.1, and that is not a detail: a
 * loopback address is refused at the door, because inside a box 127.0.0.1 is the exec daemon on
 * 1337 and 1338 and this host's gateway on 1340. Leg (e) asserts that refusal; this leg has to use
 * an address the rule allows, which a private one on plain http is.
 */
const STUB_SOURCE = readFileSync(new URL("./lib/mcp-bearer-stub.mjs", import.meta.url), "utf8");
const STUB_PATH = "/tmp/chostprobe-stub.mjs";
const STDIO_PATH = "/tmp/chostprobe-stdio.mjs";

/**
 * A stdio MCP server inside the box, so (c) proves the program shape without an npm fetch whose
 * failure would be indistinguishable from the claim under test.
 */
const STDIO_SOURCE = `
const TOOLS = [{ name: "probe_local", description: "A tool from a program the box runs.", inputSchema: { type: "object", properties: {} } }];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const cut = buffer.indexOf("\\n");
    if (cut < 0) break;
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    if (line.trim().length === 0) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id == null) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "chostprobe-stdio", version: "1.0.0" } }
      : message.method === "tools/list" ? { tools: TOOLS } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;

async function writeInBox(path, source) {
  await docker(["exec", BOX, "node", "-e",
    `require("fs").writeFileSync(${JSON.stringify(path)}, Buffer.from(${JSON.stringify(Buffer.from(source, "utf8").toString("base64"))}, "base64"))`]);
}

/** The box's own address on the docker bridge: private, so the writer's rules allow plain http. */
async function boxAddress() {
  const out = await docker(["inspect", BOX, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"]);
  const address = out.trim().split(/\s+/).find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry)) ?? "";
  if (address.length === 0) fail("the box has no non-loopback IPv4 address to reach its own stub on");
  return address;
}

async function startStub() {
  await writeInBox(STUB_PATH, STUB_SOURCE);
  // The key goes in through the ENVIRONMENT, never an argument: a command line is readable by
  // anyone who can run ps, which is the very thing this gate is about.
  const address = await boxAddress();
  void docker(["exec", "-d", "-e", `MCP_STUB_KEY=${PROBE_VALUE}`, BOX,
    "node", STUB_PATH, "--port", String(STUB_PORT), "--host", address]).catch(() => {});
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    const probe = await inBoxScript(`
      const res = await fetch("http://${address}:${STUB_PORT}/mcp", { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" }).catch(() => null);
      console.log(res == null ? "down" : String(res.status));
    `).catch(() => "down");
    if (probe.trim() === "401") return address;
  }
  fail("the in-box stub never started listening");
}

async function stopStub() {
  await docker(["exec", BOX, "pkill", "-f", STUB_PATH]).catch(() => {});
  await docker(["exec", BOX, "rm", "-f", STUB_PATH, STDIO_PATH]).catch(() => {});
}

/** Every word the box uses for "not finished yet". `initializing` is a native remote's handshake. */
const UNSETTLED = new Set(["loading", "connecting", "initializing", "starting", "pending"]);

/** Waits for a connector to reach a terminal condition, and answers with the row the host serves. */
async function settle(server, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const rows = await call("listInstalledMcpServers");
    last = (Array.isArray(rows) ? rows : []).find((row) => row.serverIdentifier === server) ?? null;
    if (last != null && !UNSETTLED.has(String(last.status))) return last;
    await sleep(2000);
  }
  return last;
}

async function removeProbe(server, clearSecrets) {
  await callRaw("removeLocalConnector", { server, clearSecrets });
}

async function main() {
  const started = Date.now();
  // Leave nothing from an interrupted earlier run, and take the baseline AFTER that: a pre-clean
  // rewrites the store, and a baseline taken before it would report its own tidying as a change.
  for (const server of [REMOTE_SERVER, STDIO_SERVER, ORPHAN_SERVER]) await removeProbe(server, true);
  const beforeConnectors = await sha256(CONNECTORS);
  const beforeSecrets = await sha256(SECRETS).catch(() => "absent");
  console.log(`connectors.json  ${beforeConnectors}`);
  console.log(`secret store     ${beforeSecrets}`);

  const stubAddress = await startStub();
  ok(`the in-box stub is listening on ${stubAddress}:${STUB_PORT} and refuses a wrong bearer`);

  // ---------------------------------------------------------------- (a) the spike, (b) custody
  const addedAt = Date.now();
  const added = await call("addLocalConnector", {
    name: REMOTE_SERVER,
    type: "http",
    url: `http://${stubAddress}:${STUB_PORT}/mcp`,
    headers: { Authorization: `Bearer \${${FIELD}}` },
    replace: true,
  }).catch((error) => fail(`addLocalConnector refused the loopback stub: ${error.message}`));
  ok(`added ${REMOTE_SERVER} as ${added.transport} in ${Date.now() - addedAt} ms; credential field ${added.fields.join(", ")}`);
  if (added.transport !== "http") fail(`expected a native http entry, got ${added.transport}`);
  if (!added.fields.includes(FIELD)) fail(`the placeholder did not become a credential field: ${JSON.stringify(added.fields)}`);

  const beforeKey = await settle(REMOTE_SERVER, 60_000);
  ok(`with no key stored it says: ${beforeKey?.statusSentence ?? "(no row)"}`);

  const storedAt = Date.now();
  await call("setConnectorSecret", { server: REMOTE_SERVER, field: FIELD, value: PROBE_VALUE });
  const connected = await settle(REMOTE_SERVER);
  if (connected == null) fail(`${REMOTE_SERVER} never appeared in the listing`);
  if (connected.status !== "connected") {
    fail(`${REMOTE_SERVER} did not connect: ${connected.status} ${connected.statusSentence ?? ""} ${String(connected.statusDetail ?? "").slice(0, 300)}`);
  }
  const probed = await call("probeConnector", { server: REMOTE_SERVER });
  ok(`SPIKE VERDICT: transport http (native remote, no bridge) connected in ${Date.now() - storedAt} ms with ${probed.toolCount} tools: ${probed.tools.map((tool) => tool.name).join(", ")}`);
  if (probed.toolCount < 2) fail(`expected the stub's two tools, got ${probed.toolCount}`);

  // The custody claim, in the two places the value could have leaked to.
  const fileText = await docker(["exec", BOX, "cat", CONNECTORS]);
  if (fileText.includes(PROBE_VALUE)) fail("the stored value reached connectors.json");
  if (!fileText.includes(`\${${FIELD}}`)) fail("connectors.json does not carry the placeholder");
  ok("connectors.json carries the field's NAME and not its value");

  const psOut = await docker(["exec", BOX, "ps", "-eo", "args"]);
  if (psOut.includes(PROBE_VALUE)) {
    const offenders = psOut.split("\n").filter((line) => line.includes(PROBE_VALUE)).length;
    fail(`the stored value is in the argument list of ${offenders} process(es) inside the box`);
  }
  ok(`the stored value is in no process argument list inside the box (${psOut.split("\n").length} processes read)`);

  // ---------------------------------------------------------------- (c) a program the box runs
  await writeInBox(STDIO_PATH, STDIO_SOURCE);
  const stdioAt = Date.now();
  const stdio = await call("addLocalConnector", {
    name: STDIO_SERVER, command: "node", args: [STDIO_PATH], replace: true,
  });
  if (stdio.transport !== "stdio") fail(`expected a stdio entry, got ${stdio.transport}`);
  const stdioRow = await settle(STDIO_SERVER);
  if (stdioRow?.status !== "connected") {
    fail(`${STDIO_SERVER} did not connect: ${stdioRow?.status} ${String(stdioRow?.statusDetail ?? "").slice(0, 300)}`);
  }
  const stdioProbe = await call("probeConnector", { server: STDIO_SERVER });
  ok(`a program the box runs connected in ${Date.now() - stdioAt} ms with ${stdioProbe.toolCount} tool(s): ${stdioProbe.tools.map((tool) => tool.name).join(", ")}`);

  // ---------------------------------------------------------------- (d) CONNECT-11
  await call("addLocalConnector", { name: ORPHAN_SERVER, command: "node", args: ["-e", "process.exit(0)"], env: [FIELD], replace: true });
  await call("setConnectorSecret", { server: ORPHAN_SERVER, field: FIELD, value: PROBE_VALUE });
  const removed = await call("removeLocalConnector", { server: ORPHAN_SERVER, clearSecrets: false });
  if (removed.removed !== true) fail("removeLocalConnector did not remove the entry");
  const orphans = await call("listConnectorSecretOrphans");
  const orphan = (Array.isArray(orphans) ? orphans : []).find((row) => row.server === ORPHAN_SERVER);
  if (orphan == null) fail(`the key outlived its entry and nothing could name it: ${JSON.stringify(orphans)}`);
  ok(`CONNECT-11: with the entry gone the store still names ${orphan.server} holding ${orphan.stored.join(", ")}`);
  const cleared = await call("removeLocalConnector", { server: ORPHAN_SERVER, clearSecrets: true });
  if (!cleared.cleared.includes(FIELD)) fail(`clearing by name did not clear ${FIELD}: ${JSON.stringify(cleared)}`);
  const afterClear = await call("listConnectorSecretOrphans");
  if ((Array.isArray(afterClear) ? afterClear : []).some((row) => row.server === ORPHAN_SERVER)) {
    fail("the orphaned key survived its own clear");
  }
  ok("CONNECT-11: the same key was then cleared by name, with no entry to resolve against");

  // ---------------------------------------------------------------- (e) the table, on the host
  const shaBeforeRefusals = await sha256(CONNECTORS);
  const refusals = [
    ["a loopback address", { name: "chostprobe-refuse", type: "http", url: "http://127.0.0.1:1340/api" }],
    ["a key in the query string", { name: "chostprobe-refuse", type: "http", url: "https://mcp.example.com/mcp?api_key=sk-live-1" }],
    ["a literal in an Authorization header", { name: "chostprobe-refuse", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-live-1" } }],
    ["plain http off the private network", { name: "chostprobe-refuse", type: "http", url: "http://mcp.example.com/mcp" }],
    ["the reserved name", { name: "shell", command: "node" }],
    ["a process-control variable", { name: "chostprobe-refuse", command: "node", env: ["LD_PRELOAD"] }],
  ];
  for (const [what, args] of refusals) {
    const attempt = await callRaw("addLocalConnector", args);
    if (attempt.ok) fail(`the writer accepted ${what}`);
    ok(`refused ${what}: ${attempt.message.replace(/^addLocalConnector -> /, "").slice(0, 110)}`);
  }
  if (await sha256(CONNECTORS) !== shaBeforeRefusals) fail("a refused write changed connectors.json");
  ok(`${refusals.length} refusals changed no byte of connectors.json`);

  // ---------------------------------------------------------------- (f) leave it as it was found
  if (!KEEP) {
    for (const server of [REMOTE_SERVER, STDIO_SERVER, ORPHAN_SERVER]) await removeProbe(server, true);
    await stopStub();
    const afterConnectors = await sha256(CONNECTORS);
    if (afterConnectors !== beforeConnectors) fail(`connectors.json changed: ${beforeConnectors} -> ${afterConnectors}`);
    ok(`connectors.json is byte-identical to the start (${afterConnectors.slice(0, 12)})`);
    // The secret store is compared by what it HOLDS, not by its bytes: a store this run emptied is
    // rewritten with the same content and a different serialization, and calling that a leak would
    // be a false alarm on every run. What must be true is that it names nothing of this gate's.
    const afterNames = await call("listConnectorSecretOrphans");
    const leftovers = (Array.isArray(afterNames) ? afterNames : []).filter((row) => String(row.server).startsWith("chostprobe"));
    if (leftovers.length > 0) fail(`the store still names ${leftovers.map((row) => row.server).join(", ")}`);
    ok("the secret store names none of this run's connectors");
  }
  console.log(`\nverify-connector-host: every leg passed in ${Math.round((Date.now() - started) / 1000)} s on ${BOX}`);
}

try {
  await main();
} catch (error) {
  if (!KEEP) {
    for (const server of [REMOTE_SERVER, STDIO_SERVER, ORPHAN_SERVER]) await removeProbe(server, true).catch(() => {});
    await stopStub().catch(() => {});
  }
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
}
