// Asserts a worker that DOES work also REPORTS it.
//
// The failure this exists to catch is not silence and not idleness. The agent calls a tool, then
// sends "Checking /workspace now." and ends the turn -- work happened, a message was delivered, and
// every completion check in the product is satisfied, while the operator learns nothing. A trace of
// one such turn reads `work=1 delivery=1 sent=1`.
//
// Ground truth is a sentinel file this script writes into /workspace under a random name. The agent
// cannot produce that token from its training or its prompt: either it looked, or it did not. That
// makes the assertion immune to the judgement call that makes this failure hard to detect from
// message text alone.
//
// Integration check, not a unit test -- needs the box running and a provider configured, so it stays
// out of `npm test`. Exit 0: the sentinel came back. Exit 1: the turn produced messages that never
// named what the agent went and looked at.
//
// Usage: node scripts/verify-work-report.mjs [--timeout-ms 240000] [--rounds 1] [--agent <id>]
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "240000"), 10);
const ROUNDS = Math.max(1, Number.parseInt(flag("--rounds", "1"), 10));

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

// SendMessage is an agent's only voice; the transcript records it as kind "send-message".
const spoken = (entries) => entries.flatMap((entry) => {
  if (entry.kind === "send-message") {
    const content = entry.message?.content;
    return typeof content === "string" && content.trim().length > 0 ? [content] : [];
  }
  return entry.kind === "message" && entry.role === "assistant"
    && typeof entry.content === "string" && entry.content.trim().length > 0
    ? [entry.content]
    : [];
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentId = flag("--agent", null) ?? (await call("listAgents"))[0]?.id;
if (agentId == null) throw new Error("no agents on the host to test with");

let failures = 0;
for (let round = 1; round <= ROUNDS; round += 1) {
  // A fresh sentinel per round: a cached answer from the previous round must not pass this one.
  const sentinel = `grokbot-verify-${Math.random().toString(36).slice(2, 10)}`;
  await docker(["exec", BOX, "sh", "-c", `printf 'sentinel\\n' > /workspace/${sentinel}.txt`]);

  const before = spoken(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", {
    agentId,
    prompt: `Check what files are in /workspace and report the exact file names you find.`,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  let said = [];
  let found = false;
  while (Date.now() < deadline) {
    await sleep(5000);
    said = spoken(await call("getAgentTranscript", { id: agentId })).slice(before);
    if (said.some((line) => line.includes(sentinel))) { found = true; break; }
  }

  await docker(["exec", BOX, "sh", "-c", `rm -f /workspace/${sentinel}.txt`]).catch(() => {});

  if (found) {
    console.log(`  PASS  round ${round} — reported ${sentinel}`);
    continue;
  }
  failures += 1;
  const tail = said.at(-1) ?? "(nothing said)";
  console.log(`  FAIL  round ${round} — never named ${sentinel}`);
  console.log(`        ${said.length} message(s); last: ${JSON.stringify(tail.slice(0, 160))}`);
}

console.log("");
if (failures > 0) {
  console.log(`${failures}/${ROUNDS} FAILED — the agent worked and did not report it`);
  process.exit(1);
}
console.log("OK");
