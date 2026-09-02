// Sends one prompt to a live local box and asserts the agent answers.
//
// This is an integration check, not a unit test: it needs the box running and an
// inference provider configured, so it stays out of `npm test`. Exit 0 means a turn
// produced an assistant entry with non-empty content; exit 1 means the turn ran and
// wrote nothing, which is the condition this exists to catch.
//
// Usage: node scripts/verify-local-turn.mjs [--timeout-ms 120000] [--rounds 5]
//
// A single round proves a turn can work. --rounds proves it keeps working: the silent turn
// this exists to catch is intermittent, and one green run is exactly how it stays hidden.
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
// indexOf returns -1 when the flag is absent, and argv[0] is the node binary -- so the old form
// parsed a path into NaN, and every wait fell through instantly and reported a silent turn.
const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "120000"), 10);
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

// An agent does not answer with assistant text -- SendMessage is its only voice, and the
// transcript records that as kind "send-message" carrying the message body. Counting
// assistant-role messages instead reports FAIL while the agent is in fact replying.
const assistants = (entries) => entries.filter((e) => {
  if (e.kind === "send-message") {
    const content = e.message?.content;
    return typeof content === "string" && content.trim().length > 0;
  }
  return e.kind === "message" && e.role === "assistant" &&
    typeof e.content === "string" && e.content.trim().length > 0;
});
const say = (e) => e.kind === "send-message" ? e.message.content : e.content;

const agents = await call("listAgents");
if (agents.length === 0) throw new Error("no agents on the host to test with");
// Skip throwaway "verify-*" agents, which another gate creates and deletes mid-run.
const agent = agents.find((a) => !a.isGroup && !String(a.name ?? "").startsWith("verify-")) ?? agents[0];
const settings = await call("getHostSettings");

console.log(`agent    ${agent.name} (${agent.id})`);
console.log(`provider ${settings.inferenceProvider}`);
console.log(`rounds   ${ROUNDS}`);

await call("openAgent", { id: agent.id }).catch(() => {});

let failed = 0;
for (let round = 1; round <= ROUNDS; round += 1) {
  const before = assistants(await call("getAgentTranscript", { id: agent.id })).length;
  await call("sendPrompt", { agentId: agent.id, prompt: `Round ${round}: reply with a short greeting.` });

  const deadline = Date.now() + TIMEOUT_MS;
  let answered = false;
  while (Date.now() < deadline && !answered) {
    await new Promise((r) => setTimeout(r, 3000));
    const found = assistants(await call("getAgentTranscript", { id: agent.id }));
    if (found.length > before) {
      console.log(`  PASS  round ${round} — ${JSON.stringify(say(found.at(-1)).slice(0, 110))}`);
      answered = true;
      break;
    }
    const trays = await call("getTrays");
    const failure = trays.find((t) => t.agentId === agent.id && t.kind === "error");
    if (failure != null) {
      console.error(`  FAIL  round ${round} — turn errored: ${failure.title} — ${failure.detail}`);
      failed += 1;
      answered = true;
      break;
    }
  }
  if (!answered) {
    console.error(`  FAIL  round ${round} — silent: no assistant entry in ${TIMEOUT_MS}ms and no error raised`);
    failed += 1;
  }
}

console.log(`\n${failed === 0 ? "OK" : `${failed}/${ROUNDS} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
