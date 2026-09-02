#!/usr/bin/env node
// model-rubric.mjs -- one repeatable battery per model, scored, so "which model works best" is a
// number measured on this box rather than an impression.
//
// Tiers, each on a FRESH throwaway agent (a 295k-token history is not a model test):
//   reach    endpoint answers and serves the model                              10
//   speak    2 turns: echo an unfakeable token; latency per turn                20
//   work     2 rounds of verify-work-report --require-evidence (fresh agent)    40
//   history  4 growth turns (~3k tokens of tool output each), then 1 evidence round  20
//   latency  median speak turn < 15 s: 10, < 30 s: 5, else 0                   10
// Cost class (free local vs paid) is reported beside the score, never folded into it.
//
// Usage: node scripts/model-rubric.mjs --models m3-glm,m3-qwen:deepseek,dell-qwen32b,xai-grok:grok-4.6 [--out file.json] [--end xai-grok]
//   an entry is <endpointId>[:<model override>]; the box ends on --end (default: the last entry's endpoint).
//   --turn-timeout-ms (default 120000) bounds each speak and growth turn.
// The box is switched through the relay's own switcher; a model override is patched into
// box-secrets.json in place and undone by the final switch.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const SECRETS = "/home/box/sand-data/box-secrets.json";
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const ENTRIES = flag("--models", "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = flag("--out", `docs/evidence/model-rubric-${new Date().toISOString().slice(0, 10)}.json`);
const END = flag("--end", null);
const RUNAWAY_REPLIES = 20;
// Reasoning models think before they speak; the turn gate allows 120 s and so does this by default.
const TURN_TIMEOUT_MS = Number.parseInt(flag("--turn-timeout-ms", "120000"), 10);
if (ENTRIES.length === 0) { console.error("usage: --models <endpointId[:model]>,..."); process.exit(2); }

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
  const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const relay = async (path, body) => (await fetch(`${GATEWAY}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const docker = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("docker", args, { maxBuffer: 16 << 20 }, (error, out) => (error ? reject(new Error(`docker: ${error.message}`)) : resolve(String(out))));
  if (input !== undefined) child.stdin.end(input);
});
const boxSh = (script, input) => docker(["exec", ...(input === undefined ? [] : ["-i"]), BOX, "sh", "-c", script], input);
const run = (args) => new Promise((resolve) => execFile("node", args, { maxBuffer: 16 << 20, env: process.env }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setModel(model) {
  await boxSh(`python3 -c "
import json,sys
p='${SECRETS}'; d=json.load(open(p)); d.setdefault('secrets',{})['SAND_OPENAI_COMPATIBLE_MODEL']=sys.stdin.read().strip()
tmp=p+'.tmp'; open(tmp,'w').write(json.dumps(d)); import os; os.chmod(tmp,0o600); os.replace(tmp,p)"`, model);
}
async function waitIdle(agentId, maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const me = (await call("listAgents")).find((a) => a.id === agentId);
    if (me == null || me.isRunning !== true) return true;
    await sleep(2000);
  }
  return false;
}
const replies = (entries) => entries.filter((e) => e.kind === "send-message" && e.message?.type === "text" && typeof e.message.content === "string");
async function turn(agentId, prompt, needle, timeoutMs) {
  await waitIdle(agentId);
  const before = replies(await call("getAgentTranscript", { id: agentId })).length;
  const started = Date.now();
  await call("sendPrompt", { agentId, prompt });
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const said = replies(await call("getAgentTranscript", { id: agentId })).slice(before);
    // Runaway brake: grok-4.20 reasoning once emitted hundreds of identical SendMessage calls per
    // completion. Deleting the throwaway agent is the only gateway-side stop, and it works.
    if (said.length > RUNAWAY_REPLIES) { await call("deleteAgent", { id: agentId }).catch(() => {}); return { ok: false, ms: Date.now() - started, said: said.length, runaway: true, last: said.at(-1)?.message.content.slice(0, 120) }; }
    if (said.some((e) => e.message.content.includes(needle))) { await waitIdle(agentId, 30_000); return { ok: true, ms: Date.now() - started, said: said.length }; }
  }
  const said = replies(await call("getAgentTranscript", { id: agentId })).slice(before);
  return { ok: false, ms: Date.now() - started, said: said.length, last: said.at(-1)?.message.content.slice(0, 120) ?? "(nothing said)" };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const workReport = async (agentId, rounds) => {
  const r = await run(["scripts/verify-work-report.mjs", "--agent", agentId, "--rounds", String(rounds), "--require-evidence", "--timeout-ms", "120000"]);
  const lines = r.out.split("\n").filter((l) => /^\s+(PASS|FAIL)/.test(l));
  return { passed: lines.filter((l) => /^\s+PASS/.test(l)).length, lines: lines.map((l) => l.trim().slice(0, 200)) };
};

async function evaluate(entry) {
  const colon = entry.indexOf(":"); // ollama tags carry their own colon: dell-qwen32b:qwen2.5:14b
  const endpointId = colon < 0 ? entry : entry.slice(0, colon);
  const override = colon < 0 ? undefined : entry.slice(colon + 1);
  const result = { entry, endpointId, model: override ?? null, startedAt: new Date().toISOString(), tiers: {}, score: 0, notes: [] };
  const t0 = Date.now();
  const sw = await relay("/endpoints/use", { id: endpointId }).catch((e) => ({ error: String(e) }));
  const health = sw?.health ?? {};
  if (override) await setModel(override);
  const model = override ?? (await boxSh(`python3 -c "import json;print(json.load(open('${SECRETS}'))['secrets'].get('SAND_OPENAI_COMPATIBLE_MODEL',''))"`)).trim();
  result.model = model;
  result.cost = /x\.ai|openai|anthropic|api\./.test(String(sw?.using ?? "") + JSON.stringify(sw)) || endpointId.startsWith("xai") ? "paid" : "free/local";
  const serves = health.reachable === true && (override ? (health.models ?? []).includes(override) : health.serves !== false);
  result.tiers.reach = { reachable: health.reachable === true, serves, ms: health.ms ?? null, models: (health.models ?? []).length };
  result.score += serves ? 10 : 0;
  if (!serves) { result.notes.push(`endpoint ${endpointId} unreachable or does not serve ${model}: ${health.detail ?? ""}`); result.wallMs = Date.now() - t0; return result; }

  const created = await call("createAgent", { name: `verify-rubric ${Math.random().toString(36).slice(2, 8)}`, description: "Throwaway agent for the model rubric. Safe to delete." });
  const agentId = created?.id ?? created?.agentId ?? created?.agent?.id;
  try {
    const speak = [];
    for (let i = 1; i <= 2; i += 1) {
      const token = `TOKEN-${Math.random().toString(36).slice(2, 10)}`;
      speak.push(await turn(agentId, `Reply with exactly this word and nothing else: ${token}`, token, TURN_TIMEOUT_MS));
    }
    if (speak.some((x) => x.runaway)) { result.notes.push("runaway during speak; agent deleted"); result.runaway = true; }
    const spoke = speak.filter((s) => s.ok).length;
    result.tiers.speak = { passed: spoke, of: 2, turnsMs: speak.map((s) => s.ms), failures: speak.filter((s) => !s.ok).map((s) => s.last) };
    result.score += spoke * 10;
    const med = median(speak.filter((s) => s.ok).map((s) => s.ms));
    result.tiers.latency = { medianMs: med };
    result.score += med == null ? 0 : med < 15_000 ? 10 : med < 30_000 ? 5 : 0;
    if (spoke === 0) { result.notes.push("could not complete a turn; work and history tiers skipped"); return result; }

    const work = await workReport(agentId, 2);
    result.tiers.work = { passed: work.passed, of: 2, lines: work.lines };
    result.score += work.passed * 20;

    const growth = [];
    for (let i = 1; i <= 4; i += 1) {
      const token = `GROW-${Math.random().toString(36).slice(2, 8)}`;
      const g = await turn(agentId, `Run exactly this shell command with your Shell tool, then send me only the last line it printed: seq 1 2000 | tr '\\n' ' '; echo; echo ${token}`, token, TURN_TIMEOUT_MS);
      growth.push(g);
      if (g.runaway) { result.notes.push(`runaway during growth turn ${i}: ${g.said} replies in one turn; agent deleted`); result.runaway = true; break; }
    }
    if (result.runaway) { result.tiers.history = { growthTurns: growth.filter((x) => x.ok).length, of: 4, passed: 0, of_rounds: 1, lines: ["runaway; history round not run"] }; return result; }
    const grown = growth.filter((g) => g.ok).length;
    const history = grown > 0 ? await workReport(agentId, 1) : { passed: 0, lines: ["growth failed; history round skipped"] };
    result.tiers.history = { growthTurns: grown, of: 4, passed: history.passed, of_rounds: 1, lines: history.lines };
    result.score += history.passed * 20;
  } catch (error) {
    result.notes.push(`error: ${String(error.message ?? error).slice(0, 200)}`);
  } finally {
    result.wallMs = Date.now() - t0;
    await call("deleteAgent", { id: agentId }).catch(() => {});
  }
  return result;
}

const results = [];
for (const entry of ENTRIES) {
  console.log(`\n=== ${entry} ===`);
  const r = await evaluate(entry);
  results.push(r);
  console.log(`  score ${r.score}/100  cost ${r.cost}  model ${r.model}  wall ${Math.round((r.wallMs ?? 0) / 1000)}s`);
  for (const [tier, v] of Object.entries(r.tiers)) console.log(`  ${tier.padEnd(8)} ${JSON.stringify(v).slice(0, 220)}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  writeFileSync(OUT, JSON.stringify({ measuredOn: "this Mac + grok-bot-local-vm", capturedAt: new Date().toISOString(), results }, null, 1));
}
const endId = END ?? ENTRIES.at(-1).split(":")[0];
const final = await relay("/endpoints/use", { id: endId }).catch(() => null);
console.log(`\nbox left on ${final?.using ?? endId}; results in ${OUT}`);
console.log("\nmodel".padEnd(46) + "score  cost        speak  work  history  median turn");
for (const r of results) console.log(`${(r.endpointId + " " + (r.model ?? "")).slice(0, 44).padEnd(46)}${String(r.score).padStart(3)}    ${String(r.cost).padEnd(11)} ${String(r.tiers.speak?.passed ?? "-").padStart(3)}/2  ${String(r.tiers.work?.passed ?? "-").padStart(2)}/2   ${String(r.tiers.history?.passed ?? "-").padStart(2)}/1     ${r.tiers.latency?.medianMs == null ? "-" : Math.round(r.tiers.latency.medianMs / 1000) + "s"}`);
