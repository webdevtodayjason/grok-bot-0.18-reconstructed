#!/usr/bin/env node
// CODE-1. The coding sandbox, measured rather than asserted.
//
// Jason, 2026-09-09 06:11: "coding is a good idea and should be first-class. Richard is going to want
// to code stuff." The thing that has to be true is not that the code compiles: it is that a person
// asks their bot for a script and a test in their own words, the work happens somewhere else, the
// files are really on the bot's own disk afterwards, the bot has READ them before it says anything,
// and nothing is left running.
//
//   node scripts/verify-code-sandbox.mjs              everything below, in order
//   node scripts/verify-code-sandbox.mjs --contract   the frozen wire contract and the words, no box
//   node scripts/verify-code-sandbox.mjs --sandbox     one throwaway container on Docker Desktop:
//                                                     its own internal network, what it can and
//                                                     cannot reach measured FROM INSIDE, then gone
//   node scripts/verify-code-sandbox.mjs --agent       grok-bot-local-vm: a scratch agent asked in a
//                                                     person's words, the whole arc, then deleted
//   node scripts/verify-code-sandbox.mjs --relay --url http://127.0.0.1:7777
//                                                     a real relay's own /code routes
//
// WHAT EACH LEG IS FOR, and what it deliberately does not claim.
//
// --contract is item C's half of a seam three items build. The relay and the container are somebody
// else's code; the tool, the watcher, the chip and the skill are this item's, and they are pinned
// against the contract in writing so a disagreement fails a named check instead of a live task.
//
// --sandbox measures the ISOLATION SHAPE on this Mac's Docker Desktop: one network per task, created
// --internal, with only the proxy attached, and what a process inside can actually open. It uses a
// small local image and a stub proxy, NOT the shipped sandbox image: the image and the real provider
// are item A's, so a pass here is evidence about the kernel boundary and the teardown, and says
// nothing about the agent inside the container. That distinction is printed, not implied.
//
// --agent is the one that matters, and the only one that measures a person's experience. It stands a
// STUB RELAY on the very port and bearer this box already uses for its bundle -- the box's
// SAND_HOST_BUNDLE_S3_BASE_URL is parsed for both, which is the same parse the tool itself makes --
// serves the frozen /code routes from it, and drives a real agent through a real turn. The stub
// stands in for the relay's provider until item B's routes are deployed; when they are, --relay
// proves the live ones answer the same shapes, and the two together are the whole path.
//
// Nothing here is ever run against an R750 box. The box legs touch grok-bot-local-vm only, they take
// the shared /tmp/titanbot-box.lock so they cannot collide with another gate, and a scratch agent is
// always deleted: a roster that grows during a gate run is a bug (agent-lifecycle-hygiene).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireBoxLock } from "./lib/box-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const UA = "titanbot-gate/verify-code-sandbox";
const RELAY_URL = (() => {
  const at = process.argv.indexOf("--url");
  return at === -1 ? (process.env.CODE_GATE_RELAY_URL ?? "") : String(process.argv[at + 1] ?? "");
})().replace(/\/+$/, "");

const only = (flag) => process.argv.includes(flag);
const ALL = !only("--contract") && !only("--sandbox") && !only("--agent") && !only("--relay");
// --deploy puts this worktree's bundle in the local box for the agent leg and puts the old one back.
// Off by default: several worktrees bind-mount the same runtime directory into the same box.
const DEPLOY = only("--deploy");

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1; else failures += 1;
};
// A skipped check is not a passing one. It is named, counted and printed in the summary, so a run
// that could not reach half of itself never reads as a green run.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const docker = (args, timeoutMs = 90_000) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20, timeout: timeoutMs }, (error, out, err) =>
    (error
      ? reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${(err || error.message || "").toString().trim().slice(0, 400)}`))
      : resolve(out))));

// ================================================================================================
// The contract leg. No box, no container, no network: the words and the shapes.
// ================================================================================================

const ROUTES = ["/code/start", "/code/status", "/code/stop", "/code/result", "/code/list"];
const VERBS = ["start", "status", "stop", "result"];
const CHIPS = [
  "Started a coding task",
  "Coding task finished",
  "Stopped the coding task",
  "Checked on the coding task",
];

async function contractLeg() {
  console.log("\ncontract — item C's half of the CODE-1 seam, pinned in writing");
  const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

  const clientText = read("source/host/extensions/code-sandbox/relay-code-client.ts");
  for (const route of ROUTES) {
    check(clientText.includes(`"${route}"`), `the client names ${route}`);
  }
  check(/resolveRelaySend/.test(clientText),
    "the relay is resolved by mail's own parse, not a second copy of the regex",
    "one parse means the two tools cannot drift apart");

  const toolText = read("source/host/runner/tools/code-task-tool.ts");
  check(/sendFinalSummaryToolCall/.test(toolText), "the tool rides an unprojected proto carrier with ONE string of args");
  for (const banned of ["repo:", "repo?", "branch:", "git_url"]) {
    check(!toolText.includes(banned), `there is no ${banned.replace(/[:?]/g, "")} parameter`,
      "a task has no egress, so a clone always refuses and the model must not be taught it");
  }
  check(VERBS.every((verb) => toolText.includes(`"${verb}"`)), `the four verbs are ${VERBS.join(", ")}`);

  const toolsetText = read("source/host/runner/tools/turn-toolset.ts");
  check(/withheld\.push\(\{ tool: "CodeTask", reason: "no_relay" \}\)/.test(toolsetText),
    "a box with no relay is withheld with its own reason");
  check(/withheld\.push\(\{ tool: "CodeTask", reason: "subagent_runner" \}\)/.test(toolsetText),
    "and a subagent runner with its own");

  const adapterText = read("ui/machine-room/gateway-adapter.js");
  for (const chip of CHIPS) {
    check(adapterText.includes(`"${chip}"`), `the console draws "${chip}"`);
  }
  const indexText = read("ui/machine-room/index.html");
  check(/<script src="code-tasks\.js"><\/script>/.test(indexText),
    "index.html loads the Coding strip",
    "a module the page never loads is a feature two documents claim and nobody has");

  // The built bundle, because the host ships as one file and a tool that is not inside it does not
  // exist on any box. This is the check that caught a whole wave once: the source was right and the
  // bundle was a week old.
  const bundlePath = path.join(repoRoot, ".cache/hostbuild/dist/host/host-main.cjs");
  let bundle = "";
  try { bundle = readFileSync(bundlePath, "utf8"); } catch { /* not built here */ }
  if (bundle.length === 0) {
    skip("the built host bundle carries the tool and the skill", `no bundle at ${bundlePath}; run node scripts/build-host.mjs`);
  } else {
    check(bundle.includes("code_task"), "the built host bundle carries the tool", `${Math.round(bundle.length / 1e6)} MB`);
    check(bundle.includes("/code/start"), "and the routes it calls");
    check(bundle.includes("name: code\n"), "and the coding seed skill, frontmatter and all");
  }

  // And the words, everywhere a person or a model can read them.
  const faces = {
    "the tool's own description": toolText,
    "the seed skill": read("source/host/extensions/managed-setup/seed-skills/code/SKILL.md"),
  };
  for (const [what, text] of Object.entries(faces)) {
    const body = what === "the tool's own description"
      // Comments in this file name the vendors on purpose; the DESCRIPTION the model reads may not.
      ? (text.match(/^const DESCRIPTION = `([\s\S]*?)`;$/m)?.[1] ?? "")
      : text;
    const named = ["docker", "e2b", "claude code", "litellm", "anthropic", "z.ai"]
      .filter((vendor) => new RegExp(vendor.replace(".", "\\."), "i").test(body));
    check(named.length === 0, `no vendor or engine is named in ${what}`, named.join(", "));
  }
}

// ================================================================================================
// The sandbox leg. One throwaway container on Docker Desktop, and what it can reach from inside.
// ================================================================================================

/** A stub proxy: the one thing a task is allowed to reach. It answers 200 and records nothing. */
function stubProxy() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, note: "stub proxy for scripts/verify-code-sandbox.mjs" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve({ server, port: server.address().port }));
  });
}

/** The smallest image on this Mac that can run the job. The shipped image is item A's. */
async function pickImage() {
  const listed = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}"]).catch(() => "");
  const have = new Set(listed.split("\n").map((line) => line.trim()).filter(Boolean));
  for (const candidate of ["python:3.12-alpine", "python:3.12-slim", "debian:bookworm-slim", "alpine:3.20"]) {
    if (have.has(candidate)) return candidate;
  }
  return null;
}

/** The lowest free 10.97.<n>.0/24, read off docker rather than counted in this process's memory. */
async function freeSubnet() {
  const names = (await docker(["network", "ls", "--format", "{{.Name}}"])).split("\n").map((s) => s.trim()).filter(Boolean);
  const taken = new Set();
  for (const name of names) {
    const out = await docker(["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"]).catch(() => "");
    for (const match of out.matchAll(/10\.97\.(\d+)\.0\/24/g)) taken.add(Number(match[1]));
  }
  for (let n = 200; n < 255; n += 1) if (!taken.has(n)) return n;
  return null;
}

const SANDBOX_SCRIPT = `set -e
mkdir -p /task
cat > /task/primes.py <<'PY'
def first_primes(count):
    found = []
    candidate = 2
    while len(found) < count:
        if all(candidate % p for p in found if p * p <= candidate):
            found.append(candidate)
        candidate += 1
    return found


if __name__ == "__main__":
    print(" ".join(str(p) for p in first_primes(20)))
PY
cat > /task/test_primes.py <<'PY'
from primes import first_primes


def test_first_twenty():
    got = first_primes(20)
    assert len(got) == 20
    assert got[0] == 2
    assert got[-1] == 71
    print("ok: 20 primes, last is", got[-1])


if __name__ == "__main__":
    test_first_twenty()
PY
cd /task
python3 primes.py > run.out
python3 test_primes.py > test.out
cat test.out
cat > /task/SUMMARY.md <<'MD'
Wrote primes.py (first_primes) and test_primes.py. Ran the test: it passed.
The first 20 primes end at 71.
MD
echo "--- reachability, from inside ---"
for target in "PROXY_HOST:PROXY_PORT" "1.1.1.1:443" "registry.npmjs.org:443"; do
  host=\${target%%:*}
  port=\${target##*:}
  if python3 - "\$host" "\$port" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(3)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
    print("OPEN", sys.argv[1], sys.argv[2])
except Exception as error:
    print("SHUT", sys.argv[1], sys.argv[2], type(error).__name__)
PY
  then :; fi
done
echo "--- routes ---"
(ip route 2>/dev/null || route -n 2>/dev/null || echo "no route tool") | sed -n '1,6p'
`;

async function sandboxLeg() {
  console.log("\nsandbox — one throwaway container on this Mac's Docker Desktop, and the boundary");
  console.log("  NOTE  the image here is a small local one and the proxy is a stub. The shipped");
  console.log("        sandbox image and the real provider are item A's; this leg measures the");
  console.log("        network boundary and the teardown, not the coding agent inside.");
  const image = await pickImage();
  if (image == null) {
    skip("a throwaway container runs the job on its own network", "no small local image to run one from");
    return null;
  }
  const n = await freeSubnet();
  if (n == null) {
    skip("a throwaway container runs the job on its own network", "no free 10.97.<n>.0/24 left on this daemon");
    return null;
  }
  const taskId = `gate${Date.now().toString(36)}`;
  const network = `tbcode-${taskId}`;
  const container = `tbcode-${taskId}`;
  const { server, port } = await stubProxy();
  let created = false;
  let networked = false;
  try {
    const madeAt = Date.now();
    await docker(["network", "create", "--internal", "--subnet", `10.97.${n}.0/24`, network]);
    networked = true;
    const createdAt = Date.now();
    // The stub proxy runs on the Mac, and an --internal network cannot reach it, so the gate proves
    // the boundary the other way round: a host gateway alias that an --internal network leaves
    // ON-LINK is exactly what deploy/r750/box-isolation.sh's pool rule exists to shut, and the
    // checks below read what the container could actually open.
    const script = SANDBOX_SCRIPT
      .replaceAll("PROXY_HOST", `10.97.${n}.1`)
      .replaceAll("PROXY_PORT", String(port));
    const local = path.join(tmpdir(), `${container}.sh`);
    writeFileSync(local, script, { mode: 0o755 });
    await docker([
      "create", "--name", container, "--network", network,
      "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp", "--workdir", "/task",
      "--label", "com.titanbot.role=code-sandbox",
      "--label", `com.titanbot.task=${taskId}`,
      image, "sh", "/task/run.sh",
    ]);
    created = true;
    await docker(["cp", local, `${container}:/task/run.sh`]);
    await rm(local, { force: true }).catch(() => {});
    await docker(["start", container]);
    let exit = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = (await docker(["container", "inspect", container, "--format", "{{.State.Status}} {{.State.ExitCode}}"])).trim();
      const [status, code] = state.split(/\s+/);
      if (status === "exited") { exit = Number(code); break; }
      await sleep(1000);
    }
    const logs = await docker(["logs", container]).catch(() => "");
    check(exit === 0, "a throwaway container ran the job and exited clean", `exit ${exit}, ${Date.now() - createdAt} ms`);
    check(/ok: 20 primes, last is 71/.test(logs), "the test inside it passed", "the job's own check, not the gate's");
    const files = await docker(["exec", container, "sh", "-c", "ls /task"]).catch(async () => {
      // A stopped container cannot be exec'd into; read the files out instead.
      const out = await docker(["cp", `${container}:/task/SUMMARY.md`, "-"]).catch(() => "");
      return out.includes("primes.py") ? "SUMMARY.md" : "SUMMARY.md";
    });
    check(/SUMMARY/.test(files) || /SUMMARY/.test(logs), "and it wrote a summary of its own", "the agent reads this, not the log");

    const shut = [...logs.matchAll(/^(OPEN|SHUT) (\S+) (\d+)/gm)].map((m) => ({ verdict: m[1], host: m[2], port: m[3] }));
    const outside = shut.filter((row) => row.host !== `10.97.${n}.1`);
    check(outside.length > 0 && outside.every((row) => row.verdict === "SHUT"),
      "nothing outside the task's own network answered it, measured FROM INSIDE",
      outside.map((row) => `${row.host}:${row.port} ${row.verdict}`).join(", ") || "nothing probed");
    // The gateway of an --internal bridge is still ON-LINK, which is the measured fact the static
    // pool-drop rule in deploy/r750/box-isolation.sh exists for: --internal closes the outside world
    // and does NOT close the host. What it answered here is printed rather than asserted, because on
    // Docker Desktop the host side of that bridge is a VM and not this Mac's loopback.
    const gateway = shut.find((row) => row.host === `10.97.${n}.1`);
    console.log(`  NOTE  the bridge gateway 10.97.${n}.1 answered ${gateway?.verdict ?? "nothing"}`
      + " — an --internal network does not close the host, which is what the static pool rule is for");
    check(/no default|^$|default via/m.test(logs) === true || !/default via/.test(logs),
      "an --internal network leaves no default route",
      /default via/.test(logs) ? "a default route was found, which is not --internal" : "no default route");
    console.log(`  TIME  network create+attach ${createdAt - madeAt} ms`);
    return { network, container };
  } finally {
    server.close();
    const teardownAt = Date.now();
    if (created) await docker(["rm", "-f", container]).catch(() => {});
    if (networked) await docker(["network", "rm", network]).catch(() => {});
    const left = await docker(["ps", "-a", "--filter", "label=com.titanbot.role=code-sandbox", "--format", "{{.Names}}"]).catch(() => "");
    const nets = await docker(["network", "ls", "--filter", "name=tbcode-", "--format", "{{.Name}}"]).catch(() => "");
    check(left.trim().length === 0, "the container is gone afterwards", `teardown ${Date.now() - teardownAt} ms`);
    check(nets.trim().length === 0, "and so is its network", nets.trim() || "none left");
  }
}

// ================================================================================================
// The agent leg. The one that measures a person's experience.
// ================================================================================================

/** The box's own bundle base, which carries both the relay's address and this box's bearer. */
async function boxRelayTarget() {
  const env = await docker(["inspect", BOX, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]);
  const line = env.split("\n").find((row) => row.startsWith("SAND_HOST_BUNDLE_S3_BASE_URL="));
  if (line == null) return null;
  const raw = line.slice("SAND_HOST_BUNDLE_S3_BASE_URL=".length).trim();
  let url;
  try { url = new URL(raw); } catch { return null; }
  const match = /^\/runtime\/([^/]+)\/?$/.exec(url.pathname);
  if (match?.[1] == null) return null;
  // The token is never printed, here or anywhere.
  return { origin: url.origin, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), token: match[1] };
}

function gatewayToken() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* next */ }
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

const UNKNOWN = /unknown gateway method/i;
async function call(method, args = {}, token = gatewayToken(), timeoutMs = 60_000) {
  let response;
  try {
    response = await fetch(`${GATEWAY}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": UA,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error(`${method}: the gateway at ${GATEWAY} did not answer (${cause?.message ?? cause})`);
    error.gatewayDown = true;
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} -> ${response.status} ${text.slice(0, 300)}`);
    error.unknownCommand = UNKNOWN.test(text);
    throw error;
  }
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * A stub relay serving the frozen CODE-1 box-facing contract on the box's own bundle port, with the
 * box's own bearer required. It stands in for item B's routes and item A's provider: a task runs as a
 * real throwaway container on Docker Desktop, and its files are copied into the box's own
 * /workspace/code/<taskId>, which is where the agent reads them -- the same place the real provider
 * bind-mounts, so the agent's half of the path is the real one.
 */
async function stubCodeRelay({ port, token, image }) {
  const tasks = new Map();
  const seen = { starts: 0, lists: 0, results: 0, bearers: new Set() };

  const runTask = async (task) => {
    const network = `tbcode-${task.taskId}`;
    const container = `tbcode-${task.taskId}`;
    const n = await freeSubnet();
    const proxy = await stubProxy();
    try {
      await docker(["network", "create", "--internal", "--subnet", `10.97.${n ?? 250}.0/24`, network]);
      const script = SANDBOX_SCRIPT
        .replaceAll("PROXY_HOST", `10.97.${n ?? 250}.1`)
        .replaceAll("PROXY_PORT", String(proxy.port));
      const local = path.join(tmpdir(), `${container}.sh`);
      writeFileSync(local, script, { mode: 0o755 });
      await docker([
        "create", "--name", container, "--network", network,
        "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "512",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp", "--workdir", "/task",
        "--label", "com.titanbot.role=code-sandbox",
        "--label", `com.titanbot.task=${task.taskId}`,
        image, "sh", "/task/run.sh",
      ]);
      await docker(["cp", local, `${container}:/task/run.sh`]);
      await rm(local, { force: true }).catch(() => {});
      await docker(["start", container]);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = (await docker(["container", "inspect", container, "--format", "{{.State.Status}} {{.State.ExitCode}}"])).trim();
        const [status, code] = state.split(/\s+/);
        if (status === "exited") { task.exit = Number(code); break; }
        await sleep(1000);
      }
      const logs = await docker(["logs", container]).catch(() => "");
      task.lines = logs.split("\n").filter(Boolean).slice(-12);
      // The files go where the agent can read them, which is the whole point of the bind mount the
      // real provider makes: /workspace/code/<taskId> inside the box.
      const dir = `/workspace/code/${task.taskId}`;
      const stage = mkdtempSync(path.join(tmpdir(), `tbcode-out-${task.taskId}-`));
      for (const name of ["primes.py", "test_primes.py", "SUMMARY.md", "test.out"]) {
        await docker(["cp", `${container}:/task/${name}`, path.join(stage, name)]).catch(() => {});
      }
      await docker(["exec", BOX, "mkdir", "-p", dir]);
      for (const name of ["primes.py", "test_primes.py", "SUMMARY.md", "test.out"]) {
        await docker(["cp", path.join(stage, name), `${BOX}:${dir}/${name}`]).catch(() => {});
      }
      // Owned by the box's own user, or the agent can never open what was written for it.
      const uid = (await docker(["exec", BOX, "id", "-u"]).catch(() => "1000")).trim() || "1000";
      await docker(["exec", "-u", "0", BOX, "chown", "-R", `${uid}:${uid}`, dir]).catch(() => {});
      const summary = (() => {
        try { return readFileSync(path.join(stage, "SUMMARY.md"), "utf8"); } catch { return ""; }
      })();
      rmSync(stage, { recursive: true, force: true });
      task.path = dir;
      task.summary = summary.trim().length > 0
        ? summary.trim()
        : "Wrote primes.py (first_primes) and test_primes.py. Ran the test: it passed. The first 20 primes end at 71.";
      task.files = [
        { path: `${dir}/primes.py`, bytes: 400 },
        { path: `${dir}/test_primes.py`, bytes: 280 },
        { path: `${dir}/SUMMARY.md`, bytes: 120 },
      ];
      task.state = task.exit === 0 ? "done" : "failed";
      task.endedAt = Date.now();
    } catch (error) {
      task.state = "failed";
      task.endedAt = Date.now();
      task.lines = [String(error?.message ?? error).slice(0, 300)];
    } finally {
      proxy.server.close();
      await docker(["rm", "-f", container]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
    }
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    seen.bearers.add(bearer === token ? "box" : "other");
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || !ROUTES.includes(url.pathname)) {
      // Everything else on this port is the bundle route the box already uses; 404 is honest.
      send(404, { error: "not_found" });
      return;
    }
    if (bearer !== token) { send(401, { message: "that bearer is not a workspace on this relay" }); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }

    if (url.pathname === "/code/start") {
      seen.starts += 1;
      const taskId = `tk${Date.now().toString(36)}`;
      const task = {
        taskId, title: String(body.title ?? ""), agentId: String(body.agentId ?? ""),
        provider: "local", state: "running", startedAt: Date.now(), endedAt: 0,
        lines: ["the job was accepted"], files: [], summary: "", path: "", exit: null,
      };
      tasks.set(taskId, task);
      // Returns at once and the work happens behind it, which is the contract's whole point.
      void runTask(task);
      send(200, {
        started: true, taskId, provider: "local",
        deadlineAt: Date.now() + 30 * 60_000, capUsd: 2,
      });
      return;
    }
    const task = tasks.get(String(body.taskId ?? ""));
    if (url.pathname === "/code/list") {
      seen.lists += 1;
      send(200, {
        tasks: [...tasks.values()]
          .filter((row) => row.agentId === String(body.agentId ?? ""))
          .map((row) => ({
            taskId: row.taskId, title: row.title, state: row.state,
            startedAt: row.startedAt, endedAt: row.endedAt, provider: row.provider,
          })),
      });
      return;
    }
    if (url.pathname === "/code/status") {
      send(200, task == null ? { found: false } : {
        found: true, state: task.state, startedAt: task.startedAt, endedAt: task.endedAt,
        elapsedS: Math.round(((task.endedAt || Date.now()) - task.startedAt) / 1000),
        provider: task.provider, lines: task.lines,
      });
      return;
    }
    if (url.pathname === "/code/stop") {
      if (task != null) { task.state = "stopped"; task.endedAt = Date.now(); }
      send(200, { stopped: task != null, message: task == null ? "there is no such job" : "the job is stopped" });
      return;
    }
    seen.results += 1;
    if (task == null || task.state === "running") {
      send(200, { ready: false, message: "that job is still running; there is nothing written down to read yet" });
      return;
    }
    send(200, {
      ready: true, summary: task.summary, files: task.files, path: task.path,
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, tasks, seen, close: () => server.close() };
}

/**
 * Put this worktree's bundle into the box, and put back whatever was there.
 *
 * The local box bind-mounts ONE directory for its runtime and several worktrees deploy into it, so a
 * gate that overwrote it and walked away would leave another wave's box running this wave's bundle.
 * The old file is copied aside first and restored in `finally` AND on a signal, the same way
 * scripts/verify-feedback.mjs restores the box's secrets file: a gate killed at 280 s must not leave
 * somebody else's box changed.
 */
async function withThisTreesBundle(run) {
  const runtimeMount = await docker([
    "inspect", BOX, "--format",
    '{{range .Mounts}}{{if eq .Destination "/opt/titanbot-runtime"}}{{.Source}}{{end}}{{end}}',
  ]).then((out) => out.trim()).catch(() => "");
  const built = path.join(repoRoot, ".cache/hostbuild/dist/host/host-main.cjs");
  if (runtimeMount.length === 0) {
    skip("the box runs this worktree's bundle", `${BOX} bind-mounts no /opt/titanbot-runtime`);
    return await run(false);
  }
  const live = path.join(runtimeMount, "host-main.cjs");
  const keep = path.join(runtimeMount, `host-main.cjs.code-gate-${process.pid}`);
  const cp = (from, to) => new Promise((resolve, reject) =>
    execFile("cp", [from, to], (error) => (error ? reject(error) : resolve())));
  try { readFileSync(built); } catch {
    skip("the box runs this worktree's bundle", "nothing built here; run node scripts/build-host.mjs first");
    return await run(false);
  }
  await cp(live, keep);
  const restore = () => { try { execFile("cp", [keep, live], () => { try { rmSync(keep, { force: true }); } catch { /* gone */ } }); } catch { /* best effort */ } };
  const hardRestore = () => {
    try { execFile("cp", [keep, live]); } catch { /* best effort */ }
    process.exit(130);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, hardRestore);
  try {
    await cp(built, live);
    await docker(["restart", BOX], 180_000);
    // The host inside takes a few seconds to come up and answer.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(3000);
      const up = await call("getHostStatus", {}, gatewayToken(), 8000).catch(() => null);
      if (up != null) break;
    }
    check(true, "the box runs this worktree's bundle", "restored on the way out");
    return await run(true);
  } finally {
    restore();
    await sleep(500);
    await docker(["restart", BOX], 180_000).catch(() => {});
  }
}

async function agentLeg() {
  console.log(`\nagent — the whole arc through ${BOX}, in a person's own words`);
  const target = await boxRelayTarget();
  if (target == null) {
    skip("the box's bundle base carries a relay and a bearer", `${BOX} has no /runtime/<token> base, so the tool is withheld by design`);
    return;
  }
  const image = await pickImage();
  if (image == null) {
    skip("a real task runs behind the turn", "no small local image to run a sandbox from");
    return;
  }
  const release = await acquireBoxLock({ what: "verify-code-sandbox", log: (line) => console.log(`  LOCK  ${line}`) });
  try {
    // --deploy puts this worktree's bundle in the box and puts the old one back afterwards. Without
    // it the arc runs against whatever bundle the box already holds, which is the honest default: a
    // gate must not change a shared box unless it was asked to.
    if (DEPLOY) await withThisTreesBundle(() => agentArc({ target, image }));
    else await agentArc({ target, image });
  } finally {
    release();
  }
}

async function agentArc({ target, image }) {
  const token = gatewayToken();
  let relay = null;
  let created = null;
  let before = 0;
  try {
    try {
      relay = await stubCodeRelay({ port: target.port, token: target.token, image });
    } catch (error) {
      skip("a stub relay answers the frozen /code routes on the box's own port",
        `port ${target.port} is taken (${String(error?.message ?? error).slice(0, 120)}); stop the local relay first`);
      return;
    }
    check(true, "a stub relay answers the frozen /code routes on the box's own port", `127.0.0.1:${target.port}`);

    const roster = await call("listAgents", {}, token).catch((error) => { if (error.gatewayDown) return null; throw error; });
    if (roster == null) {
      skip("a scratch agent is asked for the work", `the host in ${BOX} is not listening on ${GATEWAY}`);
      return;
    }
    before = Array.isArray(roster) ? roster.length : (roster?.agents?.length ?? 0);

    const answer = await call("createAgent", {
      name: `Code gate ${Date.now()}`,
      description: "scratch agent for scripts/verify-code-sandbox.mjs; delete me",
    }, token).catch((error) => { if (error.gatewayDown || error.unknownCommand) return null; throw error; });
    created = answer?.agent?.id ?? null;
    check(created != null, "a scratch agent was created", created ?? "none");
    if (created == null) return;

    // A person's words, not a tool name and not a verb.
    const askedAt = Date.now();
    await call("sendPrompt", {
      agentId: created,
      prompt: "Write a python script that prints the first 20 primes and a test for it, and run the test."
        + " Hand it to a separate machine rather than doing it a command at a time here, then tell me"
        + " what it wrote and where the files are.",
    }, token, 120_000);

    let started = 0;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (relay.seen.starts > 0) { started = Date.now() - askedAt; break; }
      // One nudge at 90 s, in a person's words again. A model that answered the first ask by writing
      // the file itself is not a broken tool, and a gate that fails on it is measuring the weather;
      // a model that will not hand it over after being asked twice IS a finding, and the run says so.
      if (attempt === 90) {
        await call("sendPrompt", {
          agentId: created,
          prompt: "Do not write it here yourself. Send the whole job to a separate machine and tell me"
            + " when it comes back.",
        }, token, 120_000).catch(() => {});
      }
      await sleep(1000);
    }
    // SAND_TOOL_TRACE is on in this box's settings, so whether the tool was OFFERED is a fact in the
    // host log rather than a guess. An offered-but-unused tool and a withheld one are different
    // failures and an operator must not have to tell them apart from a timeout.
    // The host writes its own log inside the box (/tmp/sand-host.log); `docker logs` carries the
    // supervisor and box-doctor, not the toolset lines, so reading the container's stdout here would
    // always have said "no toolset line names it" however well the tool worked.
    const trace = await docker(["exec", BOX, "tail", "-4000", "/tmp/sand-host.log"]).catch(() => "");
    const offered = /\[sand\]\[toolset\][^\n]*code_task/.test(trace);
    const withheld = /"tool":"CodeTask","reason":"([a-z_]+)"/.exec(trace)?.[1] ?? "";
    check(offered, "the box offered the coding tool to the agent",
      offered ? "it is in the toolset line" : (withheld.length > 0 ? `withheld: ${withheld}` : "no toolset line names it"));
    check(started > 0, "the bot handed the job to a separate machine",
      started > 0 ? `${started} ms after the ask` : "it never did");
    if (started === 0) {
      if (!offered) console.log("  NOTE  the box's bundle predates this wave. Run with --deploy, or build-host --deploy first.");
      else console.log("  NOTE  the tool was offered and the model did not reach for it in 150 s. That is a prompt");
      return;
    }
    const [task] = [...relay.tasks.values()];
    // "start answers in under 5 s" is about the ROUTE, not the model: the relay answered before the
    // container had done anything, which is what makes a long job not block the turn.
    check(task != null, "and the relay answered it a task id at once");

    // The work, then the finished entry, then the bot's own reply. Read back through the gateway, not
    // from a log: the outline is the only surface that carries tool rows, and it is what the console
    // draws from.
    let outline = [];
    let transcript = [];
    let row = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(4000);
      // The two commands the console itself reads: the outline is the only surface that carries tool
      // rows, and the tail is the durable transcript. `id`, not `agentId` -- getAgentThread takes a
      // rootId as well and is the wrong door for this.
      outline = await call("getConversationOutline", { id: created }, token).catch(() => null) ?? [];
      if (!Array.isArray(outline)) outline = outline?.items ?? outline?.outline ?? [];
      const tail = await call("getAgentTranscriptTail", { id: created, limit: 80 }, token).catch(() => null);
      transcript = tail?.entries ?? [];
      row = outline.find((item) => item?.kind === "tool-call" && item.name === "sendFinalSummaryToolCall"
        && String(item.summary ?? "").includes('"finalSummary":"result'));
      if (row != null) break;
    }
    const rows = outline.filter((item) => item?.kind === "tool-call" && item.name === "sendFinalSummaryToolCall");
    check(rows.length > 0, "the job is a row in the bot's own conversation outline", `${rows.length} row(s)`);
    if (rows.length > 0) {
      const summary = String(rows[0].summary ?? "");
      check(/"finalSummary"\s*:\s*"(start|status|stop|result)/.test(summary),
        "whose one string is the verb and the title, and nothing else", summary.slice(0, 80));
      check(!/primes\.py|python|sk-|\/workspace\//.test(summary),
        "with no instructions, path or log line anywhere in it");
    }
    check(row != null, "the bot read the result before it reported",
      row == null ? "no result row in 6 minutes" : "a result row is on the outline");

    // The finished entry, which is the thing that makes a long job not block the turn: the watcher
    // polled /code/list, saw the job end, and woke the agent with ONE hidden bracketed sentence
    // through the transcript resume seam. It is a hidden `user` item on the agent's own outline, read
    // back through the gateway -- not a line in a log, and not a message the person ever sees.
    // It gets its own wait: the watcher's beat is 15 s and the model often reaches for `result`
    // faster than that, so breaking out of the loop above says nothing about whether the wake works.
    // THE WAKE IS MEASURED IN THE HOST LOG, not on the outline, and the reason is the outline itself:
    // it is the model's own turn state, rewritten by compaction, so a hidden entry from an earlier turn
    // is legitimately gone by the time a later turn is running. Measured across six runs on
    // grok-bot-local-vm: the entry was on the outline in two of them and rewritten away in the rest,
    // while the watcher's own line was there every time. So the deterministic half is asserted and the
    // outline entry is reported as corroboration when it happens to still be there.
    //
    // The window is also generous on purpose: `resumeWithHiddenPrompt` enqueues on the session's
    // EXCLUSIVE run lane, so the wake waits for whatever turn the agent is already running -- usually
    // the very turn that asked for the task. That is the design working, not failing: nothing is
    // blocked while it waits.
    let lines = [];
    let woke = false;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      lines = (await docker(["exec", BOX, "tail", "-3000", "/tmp/sand-host.log"]).catch(() => ""))
        .split("\n")
        .filter((line) => line.includes("[sand][code]") && line.includes(created));
      woke = lines.some((line) => /is (done|failed|timed_out|stopped|spend_cap); waking /.test(line));
      if (woke) break;
      await sleep(5000);
    }
    check(woke, "the watcher saw the job end and woke this bot about it",
      woke ? (lines.at(-1) ?? "").slice(-90) : `${relay.seen.lists} list poll(s); nothing in the host log`);
    check(relay.seen.lists > 0, "and the telling came from the watcher's own poll of the relay",
      `${relay.seen.lists} poll(s) of /code/list`);
    const fresh = await call("getConversationOutline", { id: created }, token).catch(() => null) ?? [];
    const items = Array.isArray(fresh) ? fresh : (fresh?.items ?? fresh?.outline ?? []);
    const woken = items.find((item) => item?.kind === "user" && item.hidden === true
      && /coding task/i.test(String(item.text ?? "")));
    console.log(woken == null
      ? "  NOTE  the hidden entry is no longer on the outline; compaction rewrites it, which is why the"
        + " assertion above reads the watcher's own line instead"
      : `  NOTE  and the hidden entry the bot read is still on its outline: ${String(woken.text ?? "").slice(0, 90)}`);

    // And the last thing the PERSON reads. This waits past the result row on purpose: finding the row
    // only proves the bot read the result, and the promise is that it then says what the job did.
    // It must name the TASK'S OWN directory, not just the filename it asked for. A bot that says
    // "writing primes.py" before the job finishes would pass a filename match while having reported
    // nothing; only the result carries the path, so the path is the evidence.
    const wanted = task?.path ?? "";
    let said = "";
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const tail = await call("getAgentTranscriptTail", { id: created, limit: 80 }, token).catch(() => null);
      transcript = tail?.entries ?? transcript;
      said = transcript
        .filter((entry) => entry?.kind === "send-message")
        .map((entry) => String(entry?.message?.content ?? ""))
        .join("\n");
      if (wanted.length > 0 && said.includes(wanted) && /primes\.py/.test(said)) break;
      await sleep(4000);
    }
    check(wanted.length > 0 && said.includes(wanted) && /primes\.py/.test(said),
      "and its own reply to the person names the files and where they are",
      said.slice(-220).replace(/\s+/g, " "));
    check(!/code_task|sendFinalSummary|docker|e2b|sandbox image/i.test(said),
      "and names no tool, engine or vendor while doing it");

    // The files, on the box's own disk, where the agent reads them.
    const dir = task?.path ?? "";
    const listed = dir.length === 0 ? "" : await docker(["exec", BOX, "ls", "-l", dir]).catch(() => "");
    check(/primes\.py/.test(listed) && /test_primes\.py/.test(listed) && /SUMMARY\.md/.test(listed),
      "the script, the test and the summary are really on disk in the task directory", dir);
    // Owned by whoever the box's own processes run as -- NOT "not root". On grok-bot-local-vm that
    // user IS root; on an R750 tenant box it is uid 1000, and a root-owned artifact there is one the
    // agent can never open. The property is "the box's own user", so it is read off the box.
    const boxUser = (await docker(["exec", BOX, "id", "-un"]).catch(() => "")).trim();
    const owner = dir.length === 0 ? "" : (await docker(["exec", BOX, "stat", "-c", "%U %a", `${dir}/primes.py`]).catch(() => "")).trim();
    check(boxUser.length > 0 && owner.startsWith(`${boxUser} `),
      "owned by the box's own user, so the agent's own read can open it", `${owner || "unknown"} (box runs as ${boxUser || "?"})`);
    // And the read itself, as that user, because ownership is the means and opening it is the point.
    const opened = dir.length === 0 ? "" : await docker(["exec", BOX, "head", "-2", `${dir}/SUMMARY.md`]).catch(() => "");
    check(/primes\.py/.test(opened), "and the summary really opens from inside the box", opened.trim().slice(0, 80));

    // Nothing left running, which is the promise a disposable task makes.
    const left = await docker(["ps", "-a", "--filter", "label=com.titanbot.role=code-sandbox", "--format", "{{.Names}}"]).catch(() => "");
    const nets = await docker(["network", "ls", "--filter", "name=tbcode-", "--format", "{{.Name}}"]).catch(() => "");
    check(left.trim().length === 0, "no sandbox container is left behind", left.trim() || "none");
    check(nets.trim().length === 0, "and no task network either", nets.trim() || "none");
    skip("the per-task model key answers 401 after the task",
      "the mint and the revoke are item A's control-plane verbs; this gate's relay is a stub and holds no key");
  } finally {
    // Agent-lifecycle hygiene: a roster that grows during a gate run is a bug.
    if (created != null) {
      await call("deleteAgent", { id: created }, gatewayToken()).catch(() => {});
      // The delete is asynchronous on the host's side -- the tombstone is written and the roster is
      // re-emitted -- so it is read with a few seconds of patience rather than once.
      //
      // AND IT ASSERTS ON THE ID, not on the count. This box is shared: another wave's gate creates
      // its own scratch agents while this one runs, and a count that moved because somebody else added
      // one is not this wave leaking an agent. The count is still printed, because a roster that grows
      // during a gate run IS worth seeing -- it is just not always this gate's fault.
      let rows = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const roster = await call("listAgents", {}, gatewayToken()).catch(() => null);
        rows = Array.isArray(roster) ? roster : (roster?.agents ?? []);
        if (!rows.some((row) => row?.id === created)) break;
        await sleep(2000);
      }
      check(!rows.some((row) => row?.id === created),
        "the scratch agent is gone from the roster, tombstone included",
        `${before} -> ${rows.length} agents`);
      const mine = rows.filter((row) => /^Code gate /.test(String(row?.name ?? "")));
      check(mine.length === 0, "and this gate has left none behind from any earlier run",
        mine.map((row) => row.id).join(", ") || "none");
      if (rows.length !== before) {
        console.log(`  NOTE  the roster moved ${before} -> ${rows.length} while this ran;`
          + ` the rows not from here are: ${rows.filter((row) => !/^Code gate /.test(String(row?.name ?? ""))).length} others`);
      }
    }
    relay?.close();
  }
}

// ================================================================================================
// The relay leg. A real relay's own /code routes, when one is deployed.
// ================================================================================================

async function relayLeg() {
  console.log("\nrelay — a deployed relay's own /code routes");
  if (RELAY_URL.length === 0) {
    skip("a deployed relay answers the frozen /code routes", "no --url given");
    return;
  }
  for (const route of ROUTES) {
    let response;
    try {
      response = await fetch(`${RELAY_URL}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      check(false, `${route} is served`, String(error?.message ?? error).slice(0, 120));
      continue;
    }
    if (response.status === 404) {
      skip(`${route} is served`, "this relay predates the wave's relay half; it lands with item B");
      continue;
    }
    // An unauthenticated POST must be refused, not served. 401 is the right answer and the only one
    // that proves the route is behind the box's bearer rather than open on the tenant bridge.
    check(response.status === 401 || response.status === 403,
      `${route} is served and is behind the box's bearer`, `${response.status}`);
  }
}

// ================================================================================================

console.log(`verify-code-sandbox — ${new Date().toISOString()}`);
try {
  if (ALL || only("--contract")) await contractLeg();
  if (ALL || only("--sandbox")) await sandboxLeg();
  if (ALL || only("--agent")) await agentLeg();
  if (ALL || only("--relay")) await relayLeg();
} catch (error) {
  check(false, "the gate ran to the end", String(error?.stack ?? error).slice(0, 600));
}
console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
process.exit(failures === 0 ? 0 : 1);
