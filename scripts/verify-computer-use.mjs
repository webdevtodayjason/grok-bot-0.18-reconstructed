// Asserts a worker can actually drive its own desktop.
//
// Ground truth is a screenshot artifact on disk, not the agent's word for it. The failure this
// exists to catch is an agent that reports having looked at the screen while nothing was ever
// captured -- which is exactly what "answered in prose, reported done" looked like before the
// computer tools were adapted onto the engine's contract.
//
// The desktop tools are subagent-only by design: `turn-toolset` offers Computer only when
// `isComputerUseSubagent` is true, so the parent agent must dispatch a computerUse Task. This
// script asks for that dispatch and then checks the box's own storage for a new image.
//
// Integration check, not a unit test -- needs the box running, a desktop, and a provider, so it
// stays out of `npm test`. Exit 0: a new screenshot artifact appeared. Exit 1: none did.
//
// Usage: node scripts/verify-computer-use.mjs [--timeout-ms 300000] [--agent <id>]
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "300000"), 10);

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
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 8 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));

// Screenshots are persisted as images under the box's sand-data; count them rather than trusting
// the transcript, which is what an agent narrating a screenshot it never took would fool.
const shotCount = async () => {
  const out = await docker(["exec", BOX, "sh", "-c",
    "find /home/box/sand-data -type f \\( -name '*.webp' -o -name '*.png' \\) 2>/dev/null | wc -l"]);
  return Number.parseInt(String(out).trim(), 10) || 0;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentId = flag("--agent", null) ?? (await call("listAgents"))[0]?.id;
if (agentId == null) throw new Error("no agents on the host to test with");

// The subagent aborts with the model API returning "Internal error during token generation". Do NOT
// read that as upstream flakiness: direct grok-4.6 completions from the same box with the same key
// succeed 3/3, so something about OUR request triggers it -- the parent turn carries 33 tools and a
// history with 130+ tool results, either of which is a candidate. Retry twice, and report the abort
// honestly as unexplained rather than blaming the provider.
const ATTEMPTS = Number.parseInt(flag("--attempts", "2"), 10);
let before = 0;
let after = 0;
let providerFailed = false;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  before = await shotCount();
  console.log(`  attempt ${attempt}: screenshot artifacts before: ${before}`);
  await call("sendPrompt", {
    agentId,
    prompt: "Dispatch a computerUse subagent to take a screenshot of the desktop and describe exactly "
      + "what is on screen. Report back what it saw.",
  });

  const deadline = Date.now() + Math.floor(TIMEOUT_MS / ATTEMPTS);
  after = before;
  while (Date.now() < deadline) {
    await sleep(10000);
    after = await shotCount();
    if (after > before) break;
  }
  if (after > before) break;
  const aborted = await call("getSubagents", { id: agentId }).catch(() => []);
  providerFailed = (Array.isArray(aborted) ? aborted : []).some((s) => s.status === "aborted");
}

const subagents = await call("getSubagents", { id: agentId }).catch(() => []);
const computerUse = (Array.isArray(subagents) ? subagents : [])
  .filter((s) => String(s.subagentType ?? "").toLowerCase().includes("computer"));
console.log(`  computerUse subagents: ${computerUse.map((s) => s.status).join(", ") || "none"}`);
console.log(`  screenshot artifacts after:  ${after}`);

if (after > before) {
  console.log("\nOK");
  process.exit(0);
}
console.log(providerFailed
  ? "\nFAILED — no screenshot captured; the subagent aborted with the model API returning\n"
    + "         'Internal error during token generation'. Direct completions to the same endpoint\n"
    + "         succeed, so this is OUR request shape, not the provider. Unexplained: suspect the\n"
    + "         parent turn's 33 tools or its 130+ accumulated tool results."
  : "\nFAILED — no screenshot artifact was captured");
process.exit(1);
