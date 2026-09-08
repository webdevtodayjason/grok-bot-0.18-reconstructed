// CURSOR-1. A box that cannot reach Cursor still works, and says so in plain words.
//
// What was wrong, measured 2026-09-07 on the R750 across three boxes on one host bundle:
//
//   * every box logged "[sand:privacy] privacy-mode lookup failed, using privacy-safe fallback
//     backend=https://api2.cursor.sh/ error=ConnectError" continuously. On the Mac box that one
//     line was 1740 of the 1742 lines mentioning cursor at all.
//   * WebFetch and WebSearch answered "Error: Tool failed; this may be temporary. Try again." on
//     every call, because both route through that backend. Richard was refused six links in one
//     session and the tool never named an alternative.
//   * tenant boxes logged "inference-credential renewal failed (streak N): ENOENT" until the
//     credential file was copied by hand.
//   * the [sand][gates] line read sand_auto_review true on the demo box and false on the other
//     two, both claiming "bundled default", and on the box where it read true every Shell command
//     and every browser navigation came back "Rejected: An error occured while classifying this
//     action. Please review manually." The agent could not run one command.
//
// So this gate does not ask whether the product still has Cursor code in it. It asks the only
// question a customer can feel: with the road to Cursor closed, does the box still do the work,
// and does it stay quiet.
//
// It cuts the box off first, two ways at once, because either one alone can be argued with. The
// settings file gets SAND_BACKEND_URL pointed at a dead address (this is the switch a live box can
// take without a container recreate, which BOX-6 forbids), and /etc/hosts blackholes every Cursor
// host so anything that ignored the setting and dialled a literal URL is refused on the spot
// rather than hanging. A box that goes quiet because the calls quietly succeeded would prove
// nothing, and after this cut they cannot succeed.
//
// Then, in order:
//
//   (P) the [sand][gates] line agrees with deploy/box-defaults/gates.json, value AND source. The
//       source has to read "local pin". "bundled default" on a pinned gate is the exact failure
//       that made three boxes behave three ways, and a value that happens to be right today for
//       the wrong reason is the same bug waiting.
//   (T) two real turns: a Shell command, a WebFetch of example.com, a WebSearch, and a WebFetch of
//       a page that refuses plain fetches. Each has to succeed or fail in plain words.
//   (F) nothing anywhere in what the person or the model reads says "may be temporary" or "while
//       classifying this action", and a failed page names the next thing the person can do.
//   (Q) the host log gains no cursor line while all of that happens, and none since the host
//       started if the host has been up long enough to say.
//
// The log is not the whole answer, and CURSOR-3 is why. A caller whose only failure path is a
// telemetry report leaves no host log line at all, because mode none switches telemetry off -- so
// `teamRules.start()` opened a TLS connection to api2.cursor.sh on every host boot through the run
// that reported "0 lines mentioning cursor" on all three boxes. The boot arm watches the socket
// instead: it blackholes the Cursor hosts, listens where the blackhole points, proves the listener
// is armed, restarts the host, and fails on any connection at all.
//
// The five-minute window is its own mode. A 300 second wait does not fit beside two real turns
// under a 240 second command timeout, and a gate that has to be run without one is a gate nobody
// runs. So the default mode measures the window it actually covers and reports the length, and
//
//   timeout 330 node scripts/verify-cursor-free.mjs --quiet
//
// is the five idle minutes on their own.
//
// What this gate does NOT prove, said plainly so nobody reads it as coverage: whether the reply's
// wording keeps tool names out of the person's face. It fails on a vendor name (Cursor, TinyFish)
// because those come from the product, and it prints tool-name mentions as INFO because those come
// from the model's style and a gate whose verdict is a model's word choice is not a gate.
//
// Integration check, not a unit test: needs the box up, a provider configured, and real turns. The
// unit half (the pin file, the fetch fallback order, the error text) is tests/cursor-free.test.mjs.
//
//   timeout 240 node scripts/verify-cursor-free.mjs            the turns, and the window they cover
//   timeout 330 node scripts/verify-cursor-free.mjs --quiet    five idle minutes, nothing else
//   timeout 240 node scripts/verify-cursor-free.mjs --boot     one host restart, watched at the socket
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const QUIET_ONLY = process.argv.includes("--quiet");
// CURSOR-3. The boot arm. The log-line arms below cannot see a call whose only failure path is
// telemetry, because mode none switches telemetry off -- which is exactly how a TLS connection to
// api2.cursor.sh on every host boot survived a run that reported "0 lines mentioning cursor". This
// one watches the socket instead of the log, and it needs a boot, so it restarts the host.
const BOOT_ONLY = process.argv.includes("--boot");

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const STATSIG_CACHE = "/home/box/sand-data/sand-statsig-bootstrap.json";
const HOST_LOG = "/tmp/sand-host.log";
const HOSTS_FILE = "/etc/hosts";
const BACKEND_SETTING = "SAND_BACKEND_URL";
// The discard port. A connect there is refused immediately, so a caller that ignored the settings
// file and dialled anyway fails fast and loudly instead of hanging out the turn's budget.
const DEAD_BACKEND = "http://127.0.0.1:9/";
const PINS_PATH = new URL("../deploy/box-defaults/gates.json", import.meta.url);

// Everything the product could dial by name. /etc/hosts has no wildcards, so this is a list and it
// is meant to be one: a host that has to be added here later is a host somebody added to the code.
const CURSOR_HOSTS = [
  "api.cursor.sh", "api2.cursor.sh", "api3.cursor.sh", "api4.cursor.sh",
  "repo42.cursor.sh", "dev-staging.cursor.sh", "cursor.sh", "www.cursor.sh",
  "cursor.com", "www.cursor.com", "api.cursor.com", "marketplace.cursorapi.com",
];
const HOSTS_MARKER = "# verify-cursor-free";

const EXAMPLE_URL = process.env.CURSOR_FREE_OPEN_URL ?? "https://example.com";
// One of the six Richard was refused. It answers a plain fetch with 999/403, so it is the case the
// fallback exists for. Overridable because a site can change its mind about that at any time.
const WALLED_URL = process.env.CURSOR_FREE_WALLED_URL ?? "https://www.linkedin.com/company/anthropic";
const SEARCH_FOR = process.env.CURSOR_FREE_SEARCH ?? "node.js release schedule";

// Budgeted against a 240 second command timeout: two real turns, the preflight, and a finally that
// still has to put the settings file and /etc/hosts back and delete the probe.
const TOTAL_BUDGET_MS = 205_000;
const TURN_TIMEOUT_MS = 80_000;
// After the turn's effect lands, how long to let it finish talking before its reply is read. Short,
// because it is the tail of a turn whose work is already done, and it is bounded by the total
// budget anyway.
const SETTLE_TIMEOUT_MS = 25_000;
const QUIET_WINDOW_MS = 300_000;
const HOST_UPTIME_FOR_QUIET_S = 300;
// How long the boot arm waits for the host to come back and print its gates line, and how long it
// then watches the sink before reading it.
const BOOT_TIMEOUT_MS = 120_000;
const BOOT_WATCH_MS = 20_000;
const SINK_LOG = "/tmp/cursor-sink.log";
const SINK_SCRIPT = "/tmp/cursor-sink.cjs";

// The person and the model must never be handed either of these. The first tells the model to
// retry a call that can never succeed, so the agent loops; the second is the classifier refusing
// on behalf of a backend we do not have.
const FORBIDDEN_TEXT = [
  { needle: "may be temporary", why: "tells the model to retry a call that cannot succeed" },
  { needle: "while classifying this action", why: "the upstream review classifier refused the action" },
];
// Named for the product, not for the model's prose. A reply that says any of these is the product
// putting somebody else's brand in Titan's mouth.
// Deliberately not "api2." or any bare host fragment: a search result URL can carry one, and a
// gate that fails on somebody else's hostname is a gate that gets switched off. "cursor" already
// catches api2.cursor.sh.
const FORBIDDEN_VENDORS = ["cursor", "anysphere", "tinyfish", "statsig"];
// Printed, not failed on. See the header.
const TOOL_NAMES = ["webfetch", "websearch", "web_fetch", "web_search", "shelltoolcall", "fetch_content"];

// Any log line mentioning cursor is a failure. Nothing is excluded today; a line that turns out to
// be genuinely benign gets named here, so the exception is a decision somebody wrote down rather
// than a pattern quietly loosened until it stopped catching anything.
const BENIGN_LOG_SUBSTRINGS = [];
// Reported one by one when the window is dirty, because "17 cursor lines" and "17 privacy lookups"
// are different bugs and the first reading of a failure should say which.
const SYMPTOMS = [
  ["[sand:privacy]", "the privacy-mode lookup is still running"],
  ["inference-credential renewal failed", "the DEV credential renewer is still running"],
  ["BootstrapStatsig", "the feature-flag bootstrap is still being fetched"],
  ["/v1/traces", "OTLP tracing is still exporting"],
  ["x-cursor-", "a backend client is still stamping its headers"],
  ["ClassifySandAutoReview", "the upstream review classifier is still being called"],
];

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
// /etc/hosts is root owned inside the box and the box runs as an unprivileged user, so the two
// calls that touch it say so rather than failing with a permission error nobody expects.
const rootSh = (command) => docker(["exec", "-u", "0", BOX, "sh", "-c", command]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throw rather than exit: the finally still has to put the operator's settings file and the box's
// /etc/hosts back and delete the probe, and process.exit skips it.
class VerificationFailed extends Error {}
const fatal = (message) => { throw new VerificationFailed(message); };

const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
const remaining = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
const deadlineFor = (ms) => Date.now() + Math.max(0, Math.min(ms, remaining()));

// One ledger for the whole run so the summary can say how much of the gate actually ran. A check
// that silently drops itself is coverage lost in a diff of two logs rather than in the run.
const checks = [];
const pass = (name, detail = "") => { checks.push({ name, status: "PASS" }); console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); };
const fail = (name, detail) => { checks.push({ name, status: "FAIL" }); console.log(`FAIL  ${name} - ${detail}`); };
const skip = (name, why) => { checks.push({ name, status: "SKIP" }); console.log(`SKIP  ${name} - not reached: ${why}`); };
const info = (message) => console.log(`INFO  ${message}`);
const verdict = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));

// readSettingsFile (source/host/sand-box-setting.ts) accepts a flat object or { settings: {...} }
// and PREFERS the nested one, so both helpers resolve the container the reader picks. Writing the
// top level of an operator's nested file would move a key the resolver never consults and the
// restore would then invent one that was never there.
const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const nested = parsed.settings;
    const container = nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed;
    return container[name];
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
    + `const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

/**
 * CURSOR-4. What the host will actually resolve for a setting, and which layer decided it.
 * `readSandBoxSetting` takes the container environment first and `sand-host-settings.json` second,
 * and every box created before CURSOR-4 carries `SAND_BACKEND_URL=https://api2.cursor.sh/` in that
 * environment. So writing the file is not the same as changing the box, and this gate used to print
 * `SAND_BACKEND_URL=http://127.0.0.1:9/` while the box was still resolving the value from the
 * environment. A cut nobody reads back is a cut nobody has.
 */
const resolveSetting = async (name) => {
  const raw = await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const n=${JSON.stringify(name)};`
    + `const env=(process.env[n]??'').trim();let file='';`
    + `try{const p=JSON.parse(fs.readFileSync(${JSON.stringify(SETTINGS)},'utf8'));`
    + `const c=(p&&typeof p.settings==='object'&&p.settings!=null&&!Array.isArray(p.settings))?p.settings:p;`
    + `file=(typeof c[n]==='string'?c[n]:'').trim();}catch{}`
    + `console.log(JSON.stringify({value:env.length>0?env:file,source:env.length>0?'container env':file.length>0?'settings file':'unset'}));`]);
  try { return JSON.parse(raw.trim()); } catch { return { value: "", source: "unset" }; }
};

const hostLogLines = async () =>
  Number.parseInt((await sh(`wc -l < ${HOST_LOG} 2>/dev/null || echo 0`)).trim(), 10) || 0;
const linesSince = async (from) =>
  (await sh(`tail -n +${from + 1} ${HOST_LOG} 2>/dev/null || true`)).split("\n").filter(Boolean);

/**
 * How long the host process has been up, in seconds, read from /proc so it needs no ps flags the
 * image may not have. Returns null when it cannot be read, and the five-minute arm then reports
 * itself not reached rather than passing on a window it never measured.
 */
// The name is passed in the environment, never written into the command. `for p in /proc/[0-9]*`
// expands before the loop body runs, so the only process in that list that can carry the needle in
// its own cmdline is this shell -- and a shell whose pid sorts before the host's (2974 before 474,
// because the glob sorts as text) then matches itself. Measured 2026-09-08: the boot arm below
// found "the host", killed it, and killed its own shell, then reported a clean boot that never
// happened. The uptime arm had the same bug and was reporting the age of a shell.
const HOST_PROCESS_SCAN =
  'pid=""; for p in /proc/[0-9]*; do grep -qa "$SAND_HOST_NEEDLE" "$p/cmdline" 2>/dev/null'
  + ' && { pid=${p#/proc/}; break; }; done; ';
const inBox = (script) =>
  docker(["exec", "-e", "SAND_HOST_NEEDLE=host-main.cjs", BOX, "sh", "-c", script]);

const hostUptimeSeconds = async () => {
  try {
    const raw = (await inBox(
      HOST_PROCESS_SCAN
      + "[ -n \"$pid\" ] || exit 0; "
      + "start=$(awk '{print $22}' /proc/$pid/stat 2>/dev/null); "
      + "up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null); "
      + "[ -n \"$start\" ] && [ -n \"$up\" ] && awk -v s=\"$start\" -v u=\"$up\" 'BEGIN{printf \"%d\", u - s/100}'",
    )).trim();
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch { return null; }
};

const cursorLinesIn = (lines) => lines.filter((line) =>
  /cursor/i.test(line) && !BENIGN_LOG_SUBSTRINGS.some((benign) => line.includes(benign)));

const reportWindow = (name, lines, windowLabel) => {
  const dirty = cursorLinesIn(lines);
  if (dirty.length === 0) return pass(name, `${lines.length} host log line(s) over ${windowLabel}, none mention cursor`);
  const named = SYMPTOMS
    .filter(([needle]) => dirty.some((line) => line.includes(needle)))
    .map(([needle, why]) => `${needle} (${why})`);
  fail(name, `${dirty.length} of ${lines.length} host log line(s) over ${windowLabel} mention cursor`
    + `${named.length > 0 ? `; ${named.join("; ")}` : ""}`);
  for (const line of dirty.slice(0, 8)) console.log(`      ${line.slice(0, 220)}`);
  if (dirty.length > 8) console.log(`      … ${dirty.length - 8} more`);
};

// ---- the boot mode -------------------------------------------------------------------------

// Listens where the blackhole points and writes a line per connection. Anything that reaches it has
// dialled a Cursor host by name, whatever the host log says. It records the first bytes' length and
// the SNI when it can read one, so a hit names the caller's own handshake rather than a bare count.
const SINK_SOURCE = `
const net = require("node:net");
const fs = require("node:fs");
const note = (line) => { try { fs.appendFileSync(${JSON.stringify(SINK_LOG)}, line + "\\n"); } catch {} };
const sniOf = (chunk) => {
  const text = chunk.toString("latin1");
  const match = /([a-z0-9-]+\\.)+(cursor\\.sh|cursor\\.com|cursorapi\\.com|anysphere\\.co)/.exec(text);
  return match == null ? "" : match[0];
};
for (const port of [80, 443]) {
  const server = net.createServer((socket) => {
    note("CONNECT " + new Date().toISOString() + " port=" + port);
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("data", (chunk) => {
      note("HELLO port=" + port + " bytes=" + chunk.length + " sni=" + sniOf(chunk));
      socket.destroy();
    });
    socket.on("error", () => {});
  });
  server.on("error", (error) => note("LISTEN-FAILED port=" + port + " " + error.code));
  server.listen(port, "127.0.0.1");
}
`;

const startSink = async () => {
  const encoded = Buffer.from(SINK_SOURCE, "utf8").toString("base64");
  await rootSh(`rm -f ${SINK_LOG} ${SINK_SCRIPT}; printf %s '${encoded}' | base64 -d > ${SINK_SCRIPT}`);
  await rootSh(`setsid /exec-daemon/node ${SINK_SCRIPT} > /tmp/cursor-sink.err 2>&1 < /dev/null &`);
  await sleep(1500);
};

const sinkLines = async () => (await sh(`cat ${SINK_LOG} 2>/dev/null || true`)).split("\n").filter(Boolean);

const stopSink = async () => {
  await rootSh(`pkill -f ${SINK_SCRIPT} 2>/dev/null; rm -f ${SINK_SCRIPT} ${SINK_LOG} /tmp/cursor-sink.err`).catch(() => {});
};

const hostPid = async () => (await inBox(`${HOST_PROCESS_SCAN}echo "$pid"`)).trim();

const gatesLineCount = async () =>
  Number.parseInt((await sh(`grep -ac '\[sand\]\[gates\] ' ${HOST_LOG} 2>/dev/null || echo 0`)).trim(), 10) || 0;

if (BOOT_ONLY) {
  let cutForBoot = false;
  try {
    const blackhole = CURSOR_HOSTS.map((host) => `127.0.0.1 ${host} ${HOSTS_MARKER}`).join("\\n");
    await rootSh(`printf '%b\\n' '${blackhole}' >> ${HOSTS_FILE}`);
    cutForBoot = true;
    await startSink();

    // Prove the sink is listening before anything is measured against it. A gate that reports zero
    // because it was not watching is worse than no gate: it is the same clean line either way.
    const probe = (await docker(["exec", BOX, "node", "-e",
      "const s=require('net').connect(443,'127.0.0.1',()=>{s.write('probe');setTimeout(()=>{console.log('up');process.exit(0)},200)});"
      + "s.on('error',()=>{console.log('down');process.exit(0)});"])).trim();
    if (probe !== "up") fatal(`nothing is listening on 127.0.0.1:443 in the box (${JSON.stringify(probe)}), so a clean result would mean nothing`);
    const seenByProbe = await sinkLines();
    verdict(seenByProbe.length > 0, "the connection watcher is armed", `${seenByProbe.length} line(s) from the probe`);
    await rootSh(`: > ${SINK_LOG}`);

    const before = await hostPid();
    const fromLine = await hostLogLines();
    const gatesBefore = await gatesLineCount();
    info(`host pid ${before || "unknown"}, restarting it so a boot is measured`);
    if (before.length === 0) fatal("no host-main.cjs process to restart");
    await sh(`kill ${before} 2>/dev/null || true`);

    const by = Date.now() + BOOT_TIMEOUT_MS;
    let after = "";
    while (Date.now() < by) {
      await sleep(2000);
      after = await hostPid();
      if (after.length > 0 && after !== before) break;
    }
    if (after.length === 0 || after === before) fatal(`the host did not come back within ${BOOT_TIMEOUT_MS / 1000}s`);
    info(`host came back as pid ${after}`);

    // Counted, not read off a line offset: box-bounded-log trims the host log from the front, so a
    // line number taken before a restart can land past the end of the file afterwards.
    let booted = false;
    const gatesBy = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < gatesBy) {
      if (await gatesLineCount() > gatesBefore) { booted = true; break; }
      await sleep(2000);
    }
    verdict(booted, "the host finished starting after the restart",
      booted ? "a fresh [sand][gates] line is in the log" : "no [sand][gates] line appeared, so the boot may not have finished");

    await sleep(BOOT_WATCH_MS);
    const hits = await sinkLines();
    verdict(hits.length === 0,
      "nothing dials a Cursor host while the box boots",
      hits.length === 0
        ? `no connection reached 127.0.0.1:443 or :80 over the boot and ${BOOT_WATCH_MS / 1000}s after it`
        : `${hits.length} line(s) at the blackhole. A caller whose only failure path is telemetry leaves no host log line, `
          + "which is how this survived a run that reported zero");
    for (const line of hits.slice(0, 8)) console.log(`      ${line.slice(0, 220)}`);

    reportWindow("the host log gains no cursor line over the boot", await linesSince(fromLine), "one restart");
  } catch (error) {
    console.error(`\nSTOPPED (${elapsed()}): ${error.message}`);
    process.exitCode = 1;
  } finally {
    await stopSink();
    if (cutForBoot) {
      await rootSh(`grep -v '${HOSTS_MARKER}' ${HOSTS_FILE} > /tmp/hosts.restore && cat /tmp/hosts.restore > ${HOSTS_FILE} && rm -f /tmp/hosts.restore`).catch(() => {});
    }
    const failed = checks.filter((check) => check.status === "FAIL").length;
    const passed = checks.filter((check) => check.status === "PASS").length;
    console.log(`\n${passed} PASS / ${failed} FAIL (${elapsed()})`);
    process.exit(failed === 0 && process.exitCode !== 1 ? 0 : 1);
  }
}

// ---- the quiet mode ------------------------------------------------------------------------

if (QUIET_ONLY) {
  const from = await hostLogLines();
  console.log(`watching ${HOST_LOG} from line ${from} for ${QUIET_WINDOW_MS / 1000}s`);
  const uptime = await hostUptimeSeconds();
  info(`host up ${uptime == null ? "unknown" : `${uptime}s`}`);
  await sleep(QUIET_WINDOW_MS);
  reportWindow("the host log gains no cursor line while the box sits idle", await linesSince(from), "five idle minutes");
  const failed = checks.filter((check) => check.status === "FAIL").length;
  console.log(`\n${failed === 0 ? "OK" : "FAILED"} (${elapsed()})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- the turns -----------------------------------------------------------------------------

const transcript = async (agentId) => {
  const entries = await call("getAgentTranscript", { id: agentId }).catch(() => []);
  return Array.isArray(entries) ? entries : [];
};
const said = (entries) => entries.filter((entry) => {
  if (entry.kind === "send-message") return String(entry.message?.content ?? "").trim().length > 0;
  return entry.kind === "message" && entry.role === "assistant" && String(entry.content ?? "").trim().length > 0;
});
const text = (entry) => String(entry.kind === "send-message" ? entry.message?.content : entry.content);
const outline = async (agentId) => {
  const items = await call("getConversationOutline", { id: agentId }).catch(() => []);
  return Array.isArray(items) ? items : [];
};
const toolRows = (items, name) => items.filter((item) =>
  item.kind === "tool-call" && String(item.name ?? "").toLowerCase() === name.toLowerCase());

const isRunning = async (agentId) =>
  (await call("listAgents").catch(() => [])).find((agent) => agent.id === agentId)?.isRunning === true;

/**
 * Wait for the turn to stop before reading what it said. `awaitOutcome` returns the moment its
 * effect lands, and the effect it waits on is not the last thing the turn does -- measured on
 * grok-bot-local-vm 2026-09-07, the shell stamp landed 22 s in and the last reply at that instant
 * was still "On it, running both now.", so the check on what the fetch came back with read the
 * narration instead of the answer and failed a working fetch.
 */
const settle = async (agentId, timeoutMs) => {
  const by = deadlineFor(timeoutMs);
  while (Date.now() < by) {
    if (!await isRunning(agentId).catch(() => false)) return true;
    await sleep(3000);
  }
  return false;
};

const sendTurn = async (agentId, prompt, label) => {
  const idleBy = deadlineFor(TURN_TIMEOUT_MS);
  while (Date.now() < idleBy && await isRunning(agentId)) await sleep(3000);
  await call("sendPrompt", { agentId, prompt });
  console.log(`${label} sent (${elapsed()})`);
};

/**
 * Wait on the effect, never on the agent having spoken. The agent narrates before it acts, so
 * counting replies reads a turn as finished while the tool it is being judged on has not been
 * reached. Three idle samples in a row is the turn having ended without producing the effect, and
 * waiting out the rest of the budget on that only makes the failure slower.
 */
const awaitOutcome = async (agentId, label, timeoutMs, done) => {
  const by = deadlineFor(timeoutMs);
  let idleStreak = 0;
  while (Date.now() < by) {
    await sleep(3000);
    const outcome = await done();
    if (outcome != null) return outcome;
    const failure = (await call("getTrays").catch(() => []))
      .find((tray) => tray.agentId === agentId && tray.kind === "error");
    if (failure != null) fatal(`${label} errored: ${failure.title} - ${failure.detail}`);
    idleStreak = await isRunning(agentId).catch(() => true) ? 0 : idleStreak + 1;
    if (idleStreak >= 3) return null;
  }
  return null;
};

// The prompt asks the agent to quote a tool's own failure sentence back, on its own line. That is
// the only way to read the person-visible half of a web tool result from outside the box: the
// outline carries the arguments, not the result, and only a shell row carries output. It is also
// the one place this gate asks how it went, which is the exception Jason's rule names, so the
// vendor check below reads the narrative with those quoted lines removed.
const REPORTING_RULE = "If any step failed, quote that tool's own failure message back to me "
  + "word for word on its own line starting with FAILURE: and do not retry it. Do not work around "
  + "a failure and do not summarise it.";

const stamp = Math.random().toString(36).slice(2, 8);
// Not "probe-cursor-free-...". The quiet arm below greps the host log for the word cursor, and the
// agents extension logs an agent's name on mint, on createSession and inside every auto-review
// record. A probe named after the thing being looked for reports itself: measured on
// grok-bot-local-vm 2026-09-07, that alone was all 3 of the 3 "cursor" lines in a clean run.
const stampFile = `/workspace/probe-noupstream-${stamp}.txt`;
const previousBackend = await readSetting(BACKEND_SETTING);
let probe = null;
let hostsCut = false;
let fatalError = null;

try {
  // ---- (P) preflight: the pins decide, and they say so -------------------------------------
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8"));
  const gateLine = (await sh(`grep -F '[sand][gates] ' ${HOST_LOG} 2>/dev/null | tail -1 || true`)).trim();
  if (gateLine.length === 0) fatal(`no [sand][gates] line in ${HOST_LOG}: the host has not started since the log was cut`);
  const rows = (() => { try { return JSON.parse(gateLine.slice(gateLine.indexOf("{"))); } catch { return {}; } })();
  info(`[sand][gates] carries ${Object.keys(rows).length} row(s)`);

  const missing = Object.keys(pins).filter((name) => rows[name] == null);
  verdict(missing.length === 0,
    "every gate the product pins has a row in the [sand][gates] line",
    missing.length === 0
      ? `${Object.keys(pins).length} pinned gate(s) all named`
      : `no row for ${missing.join(", ")}; a pin nobody prints is a pin nobody can check`);

  const wrongValue = Object.entries(pins)
    .filter(([name, want]) => rows[name] != null && rows[name].value !== want)
    .map(([name, want]) => `${name}=${rows[name].value} want ${want}`);
  verdict(wrongValue.length === 0,
    "the box reads every pinned gate the way deploy/box-defaults/gates.json says",
    wrongValue.length === 0 ? `${Object.keys(pins).length} pin(s) agree` : wrongValue.join(", "));

  const wrongSource = Object.entries(pins)
    .filter(([name]) => rows[name] != null && rows[name].source !== "local pin")
    .map(([name]) => `${name} from ${JSON.stringify(rows[name].source)}`);
  verdict(wrongSource.length === 0,
    "a pinned gate reports its source as the local pin",
    wrongSource.length === 0
      ? "no pinned gate claims a bundled default or a remote evaluation"
      : `${wrongSource.join(", ")}. This is the R750 failure exactly: three boxes, one bundle, `
        + "three behaviours, every row claiming bundled default");

  const statsigCache = (await sh(`test -f ${STATSIG_CACHE} && echo yes || echo no`)).trim();
  verdict(statsigCache === "no",
    "no cached feature-flag bootstrap on the box",
    statsigCache === "no"
      ? `${STATSIG_CACHE} does not exist`
      : `${STATSIG_CACHE} exists, so a box that once had a login keeps evaluating that rollout offline`);

  // ---- (C) cut the road ---------------------------------------------------------------------
  await writeSetting(BACKEND_SETTING, DEAD_BACKEND);
  const blackhole = CURSOR_HOSTS.map((host) => `127.0.0.1 ${host} ${HOSTS_MARKER}`).join("\\n");
  await rootSh(`printf '%b\\n' '${blackhole}' >> ${HOSTS_FILE}`);
  hostsCut = true;
  // Resolved through node's own getaddrinfo rather than getent, because that is the resolver the
  // host bundle uses and it is the one binary the box is guaranteed to have.
  const resolved = (await docker(["exec", BOX, "node", "-e",
    "require('node:dns').lookup('api2.cursor.sh', (error, address) => console.log(error ? `error ${error.code}` : address))"])).trim();
  const cut = resolved === "127.0.0.1";
  const backend = await resolveSetting(BACKEND_SETTING);
  verdict(cut,
    "the box cannot reach Cursor while this gate runs",
    cut
      ? `api2.cursor.sh resolves to ${resolved}, and the host resolves ${BACKEND_SETTING}=${JSON.stringify(backend.value)} from the ${backend.source}`
      : `api2.cursor.sh resolves to ${JSON.stringify(resolved)}; everything below would be measuring a box that can still dial out`);
  if (!cut) fatal("the cut did not take, so nothing below would mean anything");

  // The second half of "two ways at once, because either one alone can be argued with". It is a
  // separate row rather than a detail on the row above, because this gate spent a whole run
  // printing the value it had written while the box resolved a different one.
  //
  // A box created before CURSOR-4 carries SAND_BACKEND_URL in its container environment, which wins
  // over the settings file; only a recreate clears it and BOX-6 forbids that on a live instance. So
  // that case is reported as not reached rather than failed -- it is a fact about the box, not a
  // defect in the product, and a gate that has to be red on every existing box is a gate somebody
  // switches off. Anything else is a failure: the write went somewhere the host does not read.
  const cutRow = `the ${BACKEND_SETTING} half of the cut takes on this box`;
  if (backend.value === DEAD_BACKEND) {
    pass(cutRow, `the host resolves ${DEAD_BACKEND} from the settings file, so both halves of the cut are real`);
  } else if (backend.source === "container env") {
    skip(cutRow, `the container environment pins ${BACKEND_SETTING}=${JSON.stringify(backend.value)}, which wins over the `
      + "settings file. Only a container recreate clears it and BOX-6 forbids that on a live instance, so on this box the "
      + "/etc/hosts blackhole is the cut and this run is one cut, not two");
  } else {
    fail(cutRow, `the host resolves ${BACKEND_SETTING}=${JSON.stringify(backend.value)} from the ${backend.source} after `
      + "this gate wrote the settings file, so the write went somewhere the host does not read");
  }

  const from = await hostLogLines();
  const windowOpenedAt = Date.now();

  probe = await call("createAgent", { name: `probe-noupstream-${stamp}`, description: "", origin: "user", isKickstartRequested: false });
  probe = probe?.agent ?? probe;
  if (probe?.id == null) fatal("createAgent returned no agent");
  console.log(`probe agent: ${probe.id}`);
  await call("openAgent", { id: probe.id }).catch(() => {});

  // ---- (T) turn one: a shell command and a page that answers a plain fetch -------------------
  await sendTurn(probe.id,
    "Do these two things, then report back.\n"
    + `1. In your box shell run exactly this one command: echo ${stamp} > ${stampFile}\n`
    + `2. Read the page ${EXAMPLE_URL} and tell me the heading on it.\n`
    + REPORTING_RULE,
    "turn one");
  const stampLanded = await awaitOutcome(probe.id, "turn one", TURN_TIMEOUT_MS, async () => {
    if ((await sh(`test -f ${stampFile} && echo yes || echo no`)).trim() !== "yes") return null;
    // Both halves, not just the stamp: the shell runs first and the fetch is what the next check
    // reads, so returning on the stamp alone stops the wait before the turn's second job.
    return toolRows(await outline(probe.id), "webFetchToolCall").length > 0 ? true : null;
  }) === true;
  await settle(probe.id, SETTLE_TIMEOUT_MS);
  const outlineOne = await outline(probe.id);
  const shellRows = toolRows(outlineOne, "shellToolCall");
  const fetchRowsOne = toolRows(outlineOne, "webFetchToolCall");

  verdict(stampLanded && shellRows.length > 0,
    "a Shell command runs with the road to Cursor closed",
    stampLanded && shellRows.length > 0
      ? `${stampFile} written, ${shellRows.length} shell row(s) in the outline`
      : `stamp file ${stampLanded ? "written" : "missing"}, ${shellRows.length} shell row(s). `
        + "On the R750 this is where the review classifier refused every command");

  const replyOne = said(await transcript(probe.id)).at(-1);
  const textOne = replyOne == null ? "" : text(replyOne);
  console.log(`turn one said (${elapsed()}): ${JSON.stringify(textOne.replace(/\s+/g, " ").slice(0, 300))}`);
  verdict(fetchRowsOne.length > 0,
    "WebFetch is reached at all",
    fetchRowsOne.length > 0 ? `${fetchRowsOne.length} row(s), ${String(fetchRowsOne[0].summary ?? "").slice(0, 120)}` : "no webFetchToolCall row in the outline");
  // example.com is served by IANA and its heading has not changed in years. Asking for the heading
  // rather than "did it work" is what separates a fetch that happened from an agent saying it did.
  const readTheOpenPage = /example domain/i.test(textOne);
  verdict(readTheOpenPage,
    "a page that answers a plain fetch is read and reported",
    readTheOpenPage
      ? `the reply carries the page's own heading from ${EXAMPLE_URL}`
      : `the reply does not carry anything only ${EXAMPLE_URL} could have given it`);

  // ---- (T) turn two: a search, and a page that refuses plain fetches --------------------------
  await sendTurn(probe.id,
    "Do these two things, then report back.\n"
    + `1. Search the web for ${JSON.stringify(SEARCH_FOR)} and give me one result URL.\n`
    + `2. Read the page ${WALLED_URL} and tell me the first thing on it.\n`
    + REPORTING_RULE,
    "turn two");
  const bothReached = await awaitOutcome(probe.id, "turn two", TURN_TIMEOUT_MS, async () => {
    const items = await outline(probe.id);
    return toolRows(items, "webSearchToolCall").length > 0
      && toolRows(items, "webFetchToolCall").length > fetchRowsOne.length ? true : null;
  }) === true;
  await settle(probe.id, SETTLE_TIMEOUT_MS);
  const outlineTwo = await outline(probe.id);
  const searchRows = toolRows(outlineTwo, "webSearchToolCall");
  const fetchRowsTwo = toolRows(outlineTwo, "webFetchToolCall");
  const replyTwo = said(await transcript(probe.id)).at(-1);
  const textTwo = replyTwo == null ? "" : text(replyTwo);
  console.log(`turn two said (${elapsed()}): ${JSON.stringify(textTwo.replace(/\s+/g, " ").slice(0, 300))}`);

  verdict(searchRows.length > 0,
    "WebSearch is reached at all",
    searchRows.length > 0 ? `${searchRows.length} row(s)` : "no webSearchToolCall row in the outline");
  verdict(fetchRowsTwo.length > fetchRowsOne.length,
    "the page that refuses plain fetches is attempted",
    fetchRowsTwo.length > fetchRowsOne.length
      ? `${fetchRowsTwo.length - fetchRowsOne.length} further webFetchToolCall row(s) for ${WALLED_URL}`
      : `no further webFetchToolCall row; the agent never tried ${WALLED_URL}`);
  if (!bothReached) info("turn two ended before both tools were seen in the outline; the rows above say which");

  const searchAnswered = /https?:\/\/\S+/i.test(textTwo);
  info(`the search ${searchAnswered ? "came back with a URL" : "returned no URL the reply carries"}`);

  // ---- (F) what the person and the model are handed ------------------------------------------
  const replies = [textOne, textTwo].filter((body) => body.length > 0);
  const everything = replies.join("\n");
  const quoted = everything.split("\n").filter((line) => /^\s*FAILURE:/i.test(line));
  const narrative = everything.split("\n").filter((line) => !/^\s*FAILURE:/i.test(line)).join("\n");
  if (quoted.length > 0) for (const line of quoted) console.log(`      quoted: ${line.trim().slice(0, 220)}`);

  for (const { needle, why } of FORBIDDEN_TEXT) {
    const hit = everything.toLowerCase().includes(needle);
    verdict(!hit,
      `no reply carries "${needle}"`,
      hit ? `${why}. This is the sentence Richard saw eleven times` : "absent from both turns");
  }

  const vendors = FORBIDDEN_VENDORS.filter((vendor) => narrative.toLowerCase().includes(vendor));
  verdict(vendors.length === 0,
    "the person is not told which vendor did the work",
    vendors.length === 0
      ? "no vendor name in either reply"
      : `the reply names ${vendors.join(", ")}. The person asked for something, not for a supplier`);
  const namedTools = TOOL_NAMES.filter((name) => narrative.toLowerCase().includes(name));
  info(`tool names in the replies: ${namedTools.length === 0 ? "none" : namedTools.join(", ")} (reported, not failed on: see the header)`);

  if (quoted.length === 0) {
    skip("a page that could not be read names the next thing the person can do",
      "nothing failed in this run, so there was no failure sentence to read");
  } else {
    const namesTheNextStep = quoted.some((line) => /in your browser/i.test(line));
    verdict(namesTheNextStep,
      "a page that could not be read names the next thing the person can do",
      namesTheNextStep
        ? "the failure sentence says to open the page in a browser"
        : `the failure sentence names no alternative: ${JSON.stringify(quoted[0].trim().slice(0, 200))}`);
  }

  // ---- (Q) the log, over the window this run actually covers ---------------------------------
  const covered = Math.round((Date.now() - windowOpenedAt) / 1000);
  reportWindow("the host log gains no cursor line while the box does the work",
    await linesSince(from), `${covered}s of real work`);

  const statsigAfter = (await sh(`test -f ${STATSIG_CACHE} && echo yes || echo no`)).trim();
  verdict(statsigAfter === "no",
    "no feature-flag bootstrap is written during the run",
    statsigAfter === "no" ? `${STATSIG_CACHE} still does not exist` : `${STATSIG_CACHE} appeared during the run`);

  const uptime = await hostUptimeSeconds();
  if (uptime == null) {
    skip("no cursor line since the host started", "the host process age could not be read from /proc");
  } else if (uptime < HOST_UPTIME_FOR_QUIET_S) {
    skip("no cursor line since the host started",
      `the host has only been up ${uptime}s and this arm needs ${HOST_UPTIME_FOR_QUIET_S}s. `
      + "Leave the box alone for five minutes and run --quiet, or re-run this after it has settled");
  } else {
    const gateLineNumber = Number.parseInt(
      (await sh(`grep -n -F '[sand][gates] ' ${HOST_LOG} 2>/dev/null | tail -1 | cut -d: -f1 || echo 0`)).trim(), 10) || 0;
    reportWindow("no cursor line since the host started", await linesSince(gateLineNumber), `${uptime}s of host uptime`);
  }
} catch (error) {
  fatalError = error;
  console.error(`\nSTOPPED (${elapsed()}): ${error.message}`);
} finally {
  // Never leave the operator's settings file rewritten and never leave the box unable to resolve a
  // hostname. Both restores run even when the run above stopped on its first check.
  await writeSetting(BACKEND_SETTING, previousBackend ?? null).catch(() => {});
  if (hostsCut) {
    await rootSh(`grep -v '${HOSTS_MARKER}' ${HOSTS_FILE} > /tmp/hosts.restore && cat /tmp/hosts.restore > ${HOSTS_FILE} && rm -f /tmp/hosts.restore`).catch(() => {});
  }
  await sh(`rm -f ${stampFile}`).catch(() => {});
  if (probe?.id != null) {
    const by = Date.now() + 20_000;
    while (Date.now() < by) {
      if (!await isRunning(probe.id).catch(() => false)) break;
      await sleep(2000);
    }
    await call("deleteAgents", { ids: [probe.id] })
      .catch(() => call("deleteAgent", { id: probe.id }).catch(() => {}));
  }
  const left = (await sh(`grep -c '${HOSTS_MARKER}' ${HOSTS_FILE} 2>/dev/null || echo 0`).catch(() => "0")).trim();
  console.log(`restored: ${BACKEND_SETTING}=${JSON.stringify(await readSetting(BACKEND_SETTING).catch(() => null) ?? null)}`
    + `, ${HOSTS_FILE} blackhole lines left=${left}`);

  const passed = checks.filter((check) => check.status === "PASS").length;
  const failed = checks.filter((check) => check.status === "FAIL").length;
  const notReached = checks.filter((check) => check.status === "SKIP").length;
  console.log(`\n${passed} PASS / ${failed} FAIL / ${notReached} not reached (${elapsed()})`);
  if (fatalError != null) console.log("the run stopped early, so the counts above are not the whole gate");
  process.exitCode = failed === 0 && fatalError == null ? 0 : 1;
}
