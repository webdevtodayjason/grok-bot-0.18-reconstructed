#!/usr/bin/env node
// verify-evidence-replay.mjs -- deterministic, model-free regression for the evidence layer
// (docs/EVIDENCE-CONTRACT.md section 6).
//
// A canned provider INSIDE the box plays the model. Round 1 replays the recorded Nemotron
// fabrication: the real Shell runs, the reply names the invented file. Round 2 is the constructed
// case: no tool, the same parroted reply. Round 3 is the control: the reply echoes the real listing.
// The real host executes the real shell; the assertions read the stamps the host wrote and the
// receipts it kept. Expected verdicts: unsupported, unverified, evidenced.
//
// --compat runs the compatibility checks instead: rows written before the feature carry no stamp,
// no attestation head sits in the Cursor forward outbox, and the outline shape is unchanged.
//
// The box is pointed at the provider by editing box-secrets.json in place (backed up first,
// restored on every exit path). Recovery if this process is killed hard:
//   docker exec grok-bot-local-vm sh -c 'cp /home/box/sand-data/box-secrets.verify-evidence-backup.json /home/box/sand-data/box-secrets.json'
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const SECRETS = "/home/box/sand-data/box-secrets.json";
const BACKUP = "/home/box/sand-data/box-secrets.verify-evidence-backup.json";
const PROVIDER_PATH = "/tmp/verify-evidence-provider.mjs";
const PROVIDER_LOG = "/tmp/verify-evidence-provider.log";
const PORT = 47812;
const INVENTED = "grokbot-verify-x1ipm3y.txt"; // the recorded invention, verbatim
const FEATURE_START_MS = Date.parse("2026-09-02T03:30:00Z");

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const COMPAT = process.argv.includes("--compat");
const KEEP_AGENT = process.argv.includes("--keep-agent");
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "90000"), 10);

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
const docker = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("docker", args, { maxBuffer: 16 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${error.message}`)) : resolve(String(out))));
  if (input !== undefined) child.stdin.end(input);
});
const boxSh = (script, input) => docker(["exec", ...(input === undefined ? [] : ["-i"]), BOX, "sh", "-c", script], input);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function patchSecrets(updates) {
  await boxSh(`python3 -c "
import json,sys
u=json.load(sys.stdin)
p='${SECRETS}'
d=json.load(open(p))
s=d.setdefault('secrets',{})
for k,v in u.items():
    if v is None: s.pop(k,None)
    else: s[k]=str(v)
tmp=p+'.tmp'
open(tmp,'w').write(json.dumps(d))
import os; os.chmod(tmp,0o600); os.replace(tmp,p)
"`, JSON.stringify(updates));
}

// --- the canned provider, run inside the box -----------------------------------------------------
const PROVIDER_SOURCE = String.raw`
import http from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.argv[2]); const logPath = process.argv[3];
const log = (e) => appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...e }) + "\n");
const INVENTED = "grokbot-verify-x1ipm3y.txt";
const listing = (first) => first + "\nproof-1788287229.txt\nteach-sessions";
const names = (tools) => tools.map((t) => t.function?.name).filter(Boolean);
const pick = (tools, exact, re) => names(tools).find((n) => n === exact) ?? names(tools).find((n) => re.test(n));
function stdoutOf(content) {
  try { const j = JSON.parse(content); const s = j?.success?.stdout ?? j?.stdout; if (typeof s === "string") return s; } catch {}
  const m = String(content).match(/grokbot-verify-[a-z0-9]+\.txt/); return m ? listing(m[0]) : String(content);
}
function decide(body) {
  const msgs = body.messages ?? []; const tools = body.tools ?? [];
  const shell = pick(tools, "Shell", /^shell$/i); const send = pick(tools, "SendMessage", /^send.?message$/i);
  // The host appends its own user-role nudges after tool results, so the round marker is the
  // latest user message that carries one, not the latest user message.
  let markerIdx = -1, round = 0;
  msgs.forEach((m, i) => {
    const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const r = m.role === "user" ? t.match(/replay round (\d)/i) : null;
    if (r) { markerIdx = i; round = Number(r[1]); }
  });
  if (round === 0) return { text: "Replay provider: no round marker in the prompt." };
  const after = msgs.slice(markerIdx + 1);
  const callNames = new Map();
  for (const m of after) if (m.role === "assistant" && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callNames.set(c.id, c.function?.name);
  const shellResult = after.find((m) => m.role === "tool" && callNames.get(m.tool_call_id) === shell);
  const sent = [...callNames.values()].includes(send);
  if (sent) return { text: "Done." };
  // Round 4, the runaway: thirty identical sends in ONE completion, as grok-4.20 once did.
  if (round === 4) return { calls: Array.from({ length: 30 }, () => ({ name: send, args: { type: "text", content: "Runaway ping: the same message thirty times." } })) };
  if (round === 2) return { call: send, args: { type: "text", content: listing(INVENTED) } };
  if (!shellResult) return { call: shell, args: { command: "ls -1 /workspace" } };
  if (round === 1) return { call: send, args: { type: "text", content: listing(INVENTED) } };
  return { call: send, args: { type: "text", content: stdoutOf(shellResult.content).trim() } };
}
let n = 0;
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString("utf8");
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.method === "GET" && /\/models$/.test(req.url)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "replay", context_length: 64000 }] })); }
  let body = {}; try { body = JSON.parse(raw); } catch {}
  const d = decide(body); n += 1;
  log({ n, url: req.url, stream: body.stream === true, tools: names(body.tools ?? []).slice(0, 40), decision: d });
  const id = "chatcmpl-replay-" + n, created = Math.floor(Date.now() / 1000), callId = "call-replay-" + n;
  const toolCalls = d.calls
    ? d.calls.map((c, i) => ({ id: callId + "-" + i, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
    : d.call ? [{ id: callId, type: "function", function: { name: d.call, arguments: JSON.stringify(d.args) } }] : [];
  const finish = toolCalls.length ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 };
  if (body.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason = null, extra = {}) => res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model ?? "replay", choices: [{ index: 0, delta, finish_reason }], ...extra }) + "\n\n");
    chunk({ role: "assistant" });
    if (toolCalls.length) chunk({ tool_calls: toolCalls.map((c, i) => ({ index: i, ...c })) }); else chunk({ content: d.text });
    chunk({}, finish, { usage });
    res.write("data: [DONE]\n\n"); return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model ?? "replay", choices: [{ index: 0, message: toolCalls.length ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: d.text }, finish_reason: finish }], usage }));
}).listen(port, "127.0.0.1");
`;

async function startProvider() {
  await boxSh(`cat > ${PROVIDER_PATH}; : > ${PROVIDER_LOG}`, PROVIDER_SOURCE);
  await docker(["exec", "-d", BOX, "sh", "-c", `exec node ${PROVIDER_PATH} ${PORT} ${PROVIDER_LOG} >/tmp/verify-evidence-provider.out 2>&1`]);
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const ok = await boxSh(`curl -s -m 2 http://127.0.0.1:${PORT}/health || true`);
    if (ok.trim() === "ok") return;
  }
  throw new Error(`provider did not come up: ${(await boxSh(`cat /tmp/verify-evidence-provider.out 2>/dev/null || true`)).slice(0, 300)}`);
}
const stopProvider = () => boxSh(`pkill -f ${PROVIDER_PATH} || true; rm -f ${PROVIDER_PATH} /tmp/verify-evidence-provider.out`).catch(() => {});
const providerLog = async () => (await boxSh(`cat ${PROVIDER_LOG} 2>/dev/null || true`)).trim().split("\n").filter(Boolean).slice(-6);

async function waitIdle(agentId) {
  for (let i = 0; i < 60; i += 1) {
    const me = (await call("listAgents")).find((a) => a.id === agentId);
    if (me == null || me.isRunning !== true) return;
    await sleep(2000);
  }
}
const textReplies = (entries) => entries.filter((e) => e.kind === "send-message" && e.message?.type === "text" && typeof e.message.content === "string");

// --- the three rounds -----------------------------------------------------------------------------
let agentId = null;
let secretsPatched = false;
let providerStarted = false;
const sentinels = [];
const cleanup = async () => {
  if (secretsPatched) { await boxSh(`cp ${BACKUP} ${SECRETS} && rm -f ${BACKUP}`).catch((e) => console.error(`  RESTORE FAILED: ${e.message}\n  run: docker exec ${BOX} sh -c 'cp ${BACKUP} ${SECRETS}'`)); secretsPatched = false; }
  if (providerStarted) { await stopProvider(); providerStarted = false; }
  for (const s of sentinels) await boxSh(`rm -f /workspace/${s}.txt`).catch(() => {});
  if (agentId != null && !KEEP_AGENT) { await call("deleteAgent", { id: agentId }).catch(() => {}); agentId = null; }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

async function round(n, expect) {
  const sentinel = `grokbot-verify-${Math.random().toString(36).slice(2, 10)}`;
  sentinels.push(sentinel);
  if (n !== 2) await boxSh(`: > /workspace/${sentinel}.txt`);
  await waitIdle(agentId);
  const before = textReplies(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", { agentId, prompt: `Evidence replay round ${n}. The contents of /workspace have just changed. Check the directory again right now and report the exact file names you find this time.` });
  const deadline = Date.now() + TIMEOUT_MS;
  let reply = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const replies = textReplies(await call("getAgentTranscript", { id: agentId })).slice(before);
    if (replies.length > 0) { reply = replies.at(-1); await waitIdle(agentId); break; }
  }
  await boxSh(`rm -f /workspace/${sentinel}.txt`).catch(() => {});
  if (reply == null) {
    console.log(`  FAIL  round ${n} — no reply within ${TIMEOUT_MS / 1000}s; provider log tail:`);
    for (const line of await providerLog()) console.log(`        ${line.slice(0, 220)}`);
    return false;
  }
  const stamp = reply.evidence ?? null;
  const evidence = stamp?.attemptId ? await call("getAgentEvidence", { id: agentId, attemptId: stamp.attemptId }).catch(() => null) : null;
  const attestations = evidence?.attestations ?? [];
  const holds = attestations.some((a) => typeof a.head === "string" && a.head.includes(sentinel));
  const checks = {
    verdict: stamp?.verdict === expect.verdict,
    missing: expect.missing == null || (stamp?.missing ?? []).includes(expect.missing),
    attestations: expect.attestations === "none" ? attestations.length === 0 : attestations.length >= 1 && holds,
    said: expect.saysSentinel ? reply.message.content.includes(sentinel) : reply.message.content.includes(INVENTED),
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(`  ${ok ? "PASS" : "FAIL"}  round ${n} — ${expect.label}: verdict ${stamp?.verdict ?? "no stamp"}${stamp?.missing?.length ? ` (missing ${stamp.missing.slice(0, 2).join(", ")})` : ""}; attestations ${attestations.length}${attestations.length ? `, holds real listing: ${holds}` : ""}`);
  if (!ok) console.log(`        checks: ${JSON.stringify(checks)}; reply: ${JSON.stringify(reply.message.content.slice(0, 120))}`);
  return ok;
}

// Thirty identical sends in one completion must deliver one message, and the host must say so.
async function runawayRound() {
  await waitIdle(agentId);
  const before = textReplies(await call("getAgentTranscript", { id: agentId })).length;
  const logBefore = Number.parseInt((await boxSh("wc -l < /tmp/sand-host.log")).trim(), 10) || 0;
  await call("sendPrompt", { agentId, prompt: "Evidence replay round 4. Say hello." });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const me = (await call("listAgents")).find((a) => a.id === agentId);
    if (me && me.isRunning !== true && textReplies(await call("getAgentTranscript", { id: agentId })).length > before) break;
  }
  await waitIdle(agentId);
  const delivered = textReplies(await call("getAgentTranscript", { id: agentId })).slice(before).length;
  const capLines = (await boxSh(`tail -n +${logBefore + 1} /tmp/sand-host.log | grep -c 'send-cap' || true`)).trim();
  const ok = delivered <= 2 && Number(capLines) >= 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  round 4 — runaway: 30 identical sends in one completion delivered ${delivered} message(s); host logged ${capLines} send-cap line(s)`);
  return ok;
}

async function compat() {
  let ok = true;
  const agents = (await call("listAgents")).filter((a) => !String(a.name ?? "").startsWith("verify-"));
  for (const a of agents.slice(0, 3)) {
    const old = (await call("getAgentTranscript", { id: a.id })).filter((e) => e.kind === "send-message" && Number(e.timestampMs) < FEATURE_START_MS);
    const stamped = old.filter((e) => e.evidence != null).length;
    console.log(`  ${stamped === 0 ? "PASS" : "FAIL"}  pre-evidence rows untouched — ${a.name}: ${old.length} older replies, ${stamped} stamped`);
    ok = ok && stamped === 0;
    const items = await call("getConversationOutline", { id: a.id }).catch(() => []);
    const allowed = new Set(["kind", "id", "name", "status", "summary", "output", "exitCode"]);
    const strange = (Array.isArray(items) ? items : []).filter((i) => i.kind === "tool-call").flatMap((i) => Object.keys(i).filter((k) => !allowed.has(k)));
    console.log(`  ${strange.length === 0 ? "PASS" : "FAIL"}  outline shape unchanged — ${a.name}: unexpected keys ${JSON.stringify([...new Set(strange)])}`);
    ok = ok && strange.length === 0;
  }
  const outbox = await boxSh(`for f in $(find /home/box/sand-data -name 'audit-outbox.json' 2>/dev/null); do cat "$f"; done; echo`);
  const forwarded = (outbox.match(/tool_result|"head"/g) ?? []).length;
  console.log(`  ${forwarded === 0 ? "PASS" : "FAIL"}  no attestation head in the forward outbox — ${forwarded} occurrence(s)`);
  ok = ok && forwarded === 0;
  const perms = (await boxSh(`stat -c '%a' /home/box/sand-data/agents/*/audit.jsonl 2>/dev/null | sort | uniq -c | tr '\\n' ' '`)).trim();
  console.log(`  INFO  ledger file modes: ${perms || "(none)"}`);
  return ok;
}

try {
  if (COMPAT) {
    console.log("compat checks");
    const ok = await compat();
    console.log(`\n${ok ? "OK" : "FAILED"}`);
    process.exit(ok ? 0 : 1);
  }
  await boxSh(`cp ${SECRETS} ${BACKUP}`);
  secretsPatched = true;
  await patchSecrets({ SAND_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${PORT}/v1`, SAND_OPENAI_COMPATIBLE_TRANSPORT: null, SAND_OPENAI_COMPATIBLE_ACCOUNT_ID: null, SAND_OPENAI_COMPATIBLE_ORIGINATOR: null, SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "evidence replay" });
  await startProvider();
  providerStarted = true;
  const created = await call("createAgent", {
    name: `verify-evidence ${Math.random().toString(36).slice(2, 8)}`,
    description: "Throwaway agent for the evidence replay gate. Safe to delete.",
  });
  agentId = created?.id ?? created?.agentId ?? created?.agent?.id ?? null;
  if (agentId == null) throw new Error(`createAgent returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`replay against a canned provider in the box; throwaway agent ${agentId}`);
  const results = [
    await round(1, { label: "recorded: tool ran, reply invented", verdict: "unsupported", missing: INVENTED, attestations: "some" }),
    await round(2, { label: "constructed: no tool, reply parroted", verdict: "unverified", missing: INVENTED, attestations: "none" }),
    await round(3, { label: "control: reply echoes the real listing", verdict: "evidenced", attestations: "some", saysSentinel: true }),
    await runawayRound(),
  ];
  const failures = results.filter((r) => !r).length;
  console.log(`\n${failures === 0 ? "OK" : `${failures}/4 FAILED`}`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(`error: ${error.message}`);
  await cleanup();
  process.exit(1);
}
