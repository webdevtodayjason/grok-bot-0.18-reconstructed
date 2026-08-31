#!/usr/bin/env node
/*
 * Does an agent know who it is?
 * -----------------------------
 * The operator's report: agents introduce themselves as Grok, or as "Grok inside Grokbot", rather
 * than as the worker they were created as. That is a prompt-assembly problem, not a UI one, so this
 * asks each agent directly through the gateway and reads what comes back.
 *
 *   node scripts/verify-agent-identity.mjs
 *   node scripts/verify-agent-identity.mjs --agent "Chief of staff"
 *
 * Exit 0 when every agent names itself and none claims to be Grok.
 */
const RELAY = process.env.MACHINE_ROOM_RELAY ?? "http://127.0.0.1:7777";
const argv = process.argv.slice(2);
const only = argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : null;
const TIMEOUT_MS = Number(process.env.IDENTITY_TIMEOUT_MS ?? 150_000);

async function api(method, args = {}) {
  const r = await fetch(`${RELAY}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(body?.error ?? `${method} ${r.status}`);
  return body;
}

const agentReplies = (transcript) => (transcript ?? [])
  .filter((e) => e.kind === "send-message")
  .map((e) => (typeof e.message?.content === "string" ? e.message.content : ""));

// Claiming to be Grok is the failure. Merely mentioning it -- "I run on Grok Bot" -- is not, so the
// patterns match self-identification rather than the bare word.
const CLAIMS_GROK = [
  /\bI(?:'m| am)\s+Grok\b/i,
  /\bmy name is\s+Grok\b/i,
  /\bthis is\s+Grok\b/i,
  /\bI(?:'m| am)\s+an?\s+Grok\b/i,
];

let failures = 0;
const agents = (await api("listAgents")).filter((a) => !a.isGroup && (!only || a.name === only));
if (agents.length === 0) { console.error("no agents to ask"); process.exit(2); }

for (const agent of agents) {
  const marker = `IDENTITY-${process.pid}-${agent.id.slice(0, 6)}`;
  const prompt = `${marker}: In one sentence, state your own name and who you work for. Use your real name.`;
  const before = agentReplies(await api("getAgentTranscript", { id: agent.id }).catch(() => [])).length;
  await api("sendPrompt", { agentId: agent.id, prompt });

  const deadline = Date.now() + TIMEOUT_MS;
  let reply = null;
  while (Date.now() < deadline && reply === null) {
    await new Promise((r) => setTimeout(r, 4000));
    const replies = agentReplies(await api("getAgentTranscript", { id: agent.id }).catch(() => []));
    if (replies.length > before) reply = replies[replies.length - 1];
  }

  if (reply === null) {
    failures += 1;
    console.log(`  FAIL  ${agent.name} — no reply within ${Math.round(TIMEOUT_MS / 1000)}s (silent turn)`);
    continue;
  }

  const claimsGrok = CLAIMS_GROK.some((re) => re.test(reply));
  const saysOwnName = reply.toLowerCase().includes(agent.name.toLowerCase());
  if (claimsGrok) {
    failures += 1;
    console.log(`  FAIL  ${agent.name} — introduces itself as Grok: ${JSON.stringify(reply.slice(0, 160))}`);
  } else if (!saysOwnName) {
    failures += 1;
    console.log(`  FAIL  ${agent.name} — never states its own name: ${JSON.stringify(reply.slice(0, 160))}`);
  } else {
    console.log(`  PASS  ${agent.name} — ${JSON.stringify(reply.slice(0, 120))}`);
  }
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
