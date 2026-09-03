// Proves a Task dispatch runs END TO END on the local path. The proof is the subagent
// record itself: a NEW record must appear and reach status "done" — a reply alone does not
// count (an agent that computes the answer itself after a failed dispatch reads fine in
// prose and proves nothing).
//
//   node scripts/verify-subagent-dispatch.mjs general
//   node scripts/verify-subagent-dispatch.mjs computer
const MODE = process.argv[2] ?? "general";
const RELAY = "http://127.0.0.1:7777";
const TIMEOUT_MS = MODE === "computer" ? 480_000 : 300_000;
const PROMPTS = {
  general: "Dispatch one generalPurpose background subagent whose only job is to output the word ATLAS. Do not compute anything yourself.",
  computer: "Use a computerUse subagent to open titaniumcomputing.com in the browser on your computer and report the exact page title.",
};
const WANT_TYPE = MODE === "computer" ? "computeruse" : "generalpurpose";

const call = async (method, args = {}) => {
  const res = await fetch(`${RELAY}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 160)}`);
  return JSON.parse(text);
};

// A fresh probe agent by default: an agent whose history is full of failed dispatches
// starts refusing to dispatch at all, which tests its patience rather than the plumbing.
const NAME = process.env.DISPATCH_AGENT ?? "Dispatch Probe";
let agent = (await call("listAgents")).find((a) => a.name === NAME && !a.isGroup);
let created = false;
if (!agent) {
  const made = await call("createAgent", { name: NAME, description: "", origin: "user", isKickstartRequested: false });
  agent = made?.agent ?? made;
  created = true;
}
if (!agent) throw new Error("no agent to test with");
// An agent this gate created is its own debris: delete it on every exit path. An agent the
// operator named through DISPATCH_AGENT is theirs and is left alone.
const finish = async (code) => {
  if (created) await call("deleteAgent", { id: agent.id }).catch(() => {});
  process.exit(code);
};
const seen = new Set((await call("getSubagents", { id: agent.id }).catch(() => []))
  .map((s) => s.subagentId));
console.log(`agent ${agent.name} · mode ${MODE} · prior subagents ${seen.size}`);
await call("sendPrompt", { agentId: agent.id, prompt: PROMPTS[MODE] });

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 6000));
  const subs = await call("getSubagents", { id: agent.id }).catch(() => []);
  const fresh = subs.filter((s) => !seen.has(s.subagentId)
    && String(s.subagentType ?? "").toLowerCase().replace(/[-_]/g, "") === WANT_TYPE);
  if (fresh.length === 0) continue;
  const states = fresh.map((s) => s.status);
  process.stdout.write(`  ${Math.round((Date.now() - deadline + TIMEOUT_MS) / 1000)}s ${states.join(",")}\n`);
  if (fresh.some((s) => s.status === "done")) {
    console.log(`PASS — ${MODE} subagent reached status "done" (${fresh.find((s) => s.status === "done").subagentId})`);
    await finish(0);
  }
  if (fresh.length > 0 && fresh.every((s) => s.status === "error")) {
    console.error(`FAIL — every fresh ${MODE} subagent errored`);
    await finish(1);
  }
}
console.error(`FAIL — no fresh ${WANT_TYPE} subagent reached "done" within ${TIMEOUT_MS}ms`);
await finish(1);
