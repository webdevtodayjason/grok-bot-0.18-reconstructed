// Proves a conversation stays usable as it grows.
//
// Default mode: automatic compaction fires on the local-provider route. The failure this exists
// to catch is the one every local executor had -- a context window reported as zero, so the
// compaction trigger's first line (`if (maxTokens <= 0) return`) bailed forever and a conversation
// grew until the provider rejected the prompt.
//
// --recover: an agent that overflows the provider recovers instead of failing every turn. The
// compact-and-retry rescue keys on InputTokenLimitError; the local transport never produced one,
// so the same oversize prompt was resent, and rejected, on every turn that followed.
//
// A real overflow of grok-4.6 means accumulating ~500k tokens of history and would cost real
// money per run, so both modes run the box's traffic through a tiny proxy INSIDE the box that
// forwards to the real endpoint unchanged (authorization header included, never read here) and,
// in --recover, enforces a small prompt cap by answering with the exact 400 body a live xAI probe
// returned on 2026-09-01. The model, the tools, the summarizer and the transcript are all real;
// only the limit is small. Settings are re-read from box-secrets.json on every call, so pointing
// the box at the proxy needs no restart, and the file is backed up first and restored on every
// exit path.
//
// Ground truth is measured, not inferred: the host prints `[sand][turn] conversation compacted`
// when a checkpoint carries a new summary archive, and the transcript must still hold every
// turn afterwards. A turn merely succeeding proves nothing here -- it did all afternoon.
//
// Integration check, not a unit test. Exit 0 only when the measured evidence appears.
//
// Usage: node scripts/verify-compaction.mjs [--recover] [--timeout-ms 240000] [--max-turns 12]
//                                           [--keep-agent]
//
// If this process is killed hard, the box may be left pointed at a dead proxy. Recovery:
//   docker exec grok-bot-local-vm sh -c 'cp /home/box/sand-data/box-secrets.verify-compaction-backup.json /home/box/sand-data/box-secrets.json'
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SECRETS = "/home/box/sand-data/box-secrets.json";
const BACKUP = "/home/box/sand-data/box-secrets.verify-compaction-backup.json";
const PROXY_PATH = "/tmp/verify-compaction-proxy.mjs";
const PROXY_LOG = "/tmp/verify-compaction-proxy.log";
const PROXY_PORT = 47811;
const HOST_LOG = "/tmp/sand-host.log";

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const RECOVER = process.argv.includes("--recover");
const KEEP_AGENT = process.argv.includes("--keep-agent");
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "240000"), 10);
const MAX_TURNS = Number.parseInt(flag("--max-turns", "12"), 10);

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

// --- secrets: only the base URL and model ever leave the container ------------------------------
async function readEndpoint() {
  const out = await boxSh(`python3 -c "import json;s=json.load(open('${SECRETS}'))['secrets'];print(s.get('SAND_OPENAI_COMPATIBLE_BASE_URL',''));print(s.get('SAND_OPENAI_COMPATIBLE_MODEL',''))"`);
  const [baseUrl, model] = out.trim().split("\n");
  if (!baseUrl || !model) throw new Error("box-secrets.json has no OpenAI-compatible endpoint configured");
  return { baseUrl, model };
}
// Edits in place inside the container; values are passed through stdin, never a shell string.
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

// --- the proxy, run inside the box on node 20 ----------------------------------------------------
const PROXY_SOURCE = String.raw`
import http from "node:http";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";
const upstream = process.argv[2].replace(/\/+$/, "");
const port = Number(process.argv[3]);
const logPath = process.argv[4];
let capChars = 0;
let relativeCapChars = 0;
const log = (entry) => appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/__cap") {
    const body = JSON.parse(raw.toString("utf8"));
    capChars = Number(body.capChars) || 0;
    relativeCapChars = Number(body.relativeChars) || 0;
    log({ cap: capChars, relativeCap: relativeCapChars });
    res.writeHead(200); return res.end("ok");
  }
  const path = req.url.replace(/^\/v1/, "");
  const target = upstream + path;
  const headers = {};
  for (const h of ["authorization", "content-type", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
  if (req.method === "POST" && path === "/chat/completions") {
    let promptChars = 0;
    try { promptChars = JSON.stringify(JSON.parse(raw.toString("utf8")).messages ?? []).length; } catch {}
    const estTokens = Math.ceil(promptChars / 4);
    // A relative cap arms itself off the first prompt seen, so the run needs no warm-up turn to
    // measure the base prompt: the first turn's tool-result step is already over the line.
    if (capChars === 0 && relativeCapChars > 0) { capChars = promptChars + relativeCapChars; log({ capFrom: promptChars, cap: capChars }); }
    if (capChars > 0 && promptChars > capChars) {
      // Verbatim shape from a live xAI overflow probe (2026-09-01), figures substituted.
      const body = JSON.stringify({ code: "invalid-argument", error: "This model's maximum prompt length is " + Math.ceil(capChars / 4) + " but the request contains " + estTokens + " tokens." });
      log({ path, promptChars, estTokens, rejected: true, status: 400 });
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(body);
    }
    let up;
    try { up = await fetch(target, { method: "POST", headers, body: raw }); }
    catch (e) { log({ path, promptChars, error: String(e) }); res.writeHead(502); return res.end("proxy: upstream unreachable"); }
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
    let text = "";
    const body = Readable.fromWeb(up.body);
    body.on("data", (d) => { text += d.toString("utf8"); res.write(d); });
    body.on("end", () => {
      res.end();
      const m = [...text.matchAll(/"prompt_tokens":\s*(\d+)/g)].pop();
      log({ path, promptChars, estTokens, rejected: false, status: up.status, promptTokens: m ? Number(m[1]) : null });
    });
    body.on("error", () => { res.end(); log({ path, promptChars, rejected: false, status: up.status, streamError: true }); });
    return;
  }
  let up;
  try { up = await fetch(target, { method: req.method, headers, body: req.method === "GET" ? undefined : raw }); }
  catch (e) { res.writeHead(502); return res.end("proxy: upstream unreachable"); }
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
  res.end(Buffer.from(await up.arrayBuffer()));
  log({ path, method: req.method, status: up.status });
}).listen(port, "127.0.0.1");
`;

async function startProxy(upstream) {
  await boxSh(`cat > ${PROXY_PATH}; : > ${PROXY_LOG}`, PROXY_SOURCE);
  await docker(["exec", "-d", BOX, "sh", "-c", `exec node ${PROXY_PATH} '${upstream}' ${PROXY_PORT} ${PROXY_LOG} >/tmp/verify-compaction-proxy.out 2>&1`]);
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const ok = await boxSh(`curl -s -m 2 http://127.0.0.1:${PROXY_PORT}/health || true`);
    if (ok.trim() === "ok") return;
  }
  const out = await boxSh(`cat /tmp/verify-compaction-proxy.out 2>/dev/null || true`);
  throw new Error(`proxy did not come up: ${out.slice(0, 300)}`);
}
// pkill, not a pgrep loop: pgrep -f matches the shell running it, whose own command line carries
// the pattern, and the loop would kill that shell first.
const stopProxy = () => boxSh(`pkill -f ${PROXY_PATH} || true; rm -f ${PROXY_PATH} /tmp/verify-compaction-proxy.out`).catch(() => {});
const setCap = (body) => boxSh(`curl -s -m 2 -X POST http://127.0.0.1:${PROXY_PORT}/__cap -d '${JSON.stringify(body)}' >/dev/null`);
async function proxyLog() {
  const out = await boxSh(`cat ${PROXY_LOG} 2>/dev/null || true`);
  return out.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// --- host log: read only what appeared after a marker ----------------------------------------------
const hostLogLines = async () => Number.parseInt((await boxSh(`wc -l < ${HOST_LOG}`)).trim(), 10) || 0;
const hostLogSince = async (marker, pattern) =>
  (await boxSh(`tail -n +${marker + 1} ${HOST_LOG} | grep -F '${pattern}' || true`)).trim();

// --- agent turns ----------------------------------------------------------------------------------
const spoken = (entries) => entries.flatMap((e) => {
  if (e.kind === "send-message") { const c = e.message?.content; return typeof c === "string" && c.trim() ? [c] : []; }
  return [];
});
async function waitIdle(agentId) {
  for (let i = 0; i < 60; i += 1) {
    const me = (await call("listAgents")).find((a) => a.id === agentId);
    if (me == null || me.isRunning !== true) return;
    await sleep(2000);
  }
}
// Sends a prompt carrying a random sentinel and waits until the agent says it back. The sentinel
// is unfakeable, so its appearance proves the turn ran to a real answer.
async function turn(agentId, buildPrompt) {
  await waitIdle(agentId);
  const sentinel = `TOKEN-${Math.random().toString(36).slice(2, 10)}`;
  const before = spoken(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", { agentId, prompt: buildPrompt(sentinel) });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    const said = spoken(await call("getAgentTranscript", { id: agentId })).slice(before);
    if (said.some((line) => line.includes(sentinel))) return { ok: true, sentinel };
  }
  return { ok: false, sentinel };
}
const smallPrompt = (s) => `Reply with exactly this word and nothing else: ${s}`;
// Grows the history by a few thousand tokens per turn through a tool result the agent must read.
// ~9k chars of tool result per turn. Sized with the recover cap below: one result must fit under
// the cap on top of the base prompt, two must not.
const growthPrompt = (s) => `Run exactly this shell command with your Shell tool, then send me only the last line it printed: seq 1 2000 | tr '\\n' ' '; echo; echo ${s}`;

// --- main -----------------------------------------------------------------------------------------
let agentId = null;
let secretsPatched = false;
let proxyStarted = false;
const cleanup = async () => {
  if (secretsPatched) { await boxSh(`cp ${BACKUP} ${SECRETS} && rm -f ${BACKUP}`).catch((e) => console.error(`  RESTORE FAILED: ${e.message}\n  run: docker exec ${BOX} sh -c 'cp ${BACKUP} ${SECRETS}'`)); secretsPatched = false; }
  if (proxyStarted) { await stopProxy(); proxyStarted = false; }
  if (agentId != null && !KEEP_AGENT) { await call("deleteAgent", { id: agentId }).catch(() => {}); agentId = null; }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

let exitCode = 1;
try {
  const { baseUrl, model } = await readEndpoint();
  console.log(`  mode: ${RECOVER ? "recover (provider overflow -> compact-and-retry)" : "automatic compaction"}`);
  console.log(`  endpoint: ${baseUrl} model ${model}`);
  await boxSh(`cp -p ${SECRETS} ${BACKUP}`);
  secretsPatched = true;
  await startProxy(baseUrl);
  proxyStarted = true;
  await patchSecrets({
    SAND_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
    // recover: keep automatic compaction far away so the provider's rejection is what fires.
    SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: RECOVER ? 1_000_000 : null,
  });
  const marker = await hostLogLines();

  const created = await call("createAgent", {
    name: `verify-compaction ${Math.random().toString(36).slice(2, 8)}`,
    description: "Throwaway agent for the compaction verification gate. Safe to delete.",
  });
  agentId = created?.id ?? created?.agentId ?? created?.agent?.id ?? null;
  if (agentId == null) throw new Error(`createAgent returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`  created fresh agent ${agentId}`);

  let compacted = "";
  let transcriptBefore = 0;

  if (RECOVER) {
    // The cap arms itself 16,000 chars above the first prompt the proxy sees. Compaction cannot
    // shrink the system prompt, so the cap must leave room for the base prompt plus ONE tool
    // result (~9k chars) plus a summary, while two results overflow it: the second growth turn is
    // rejected, the rescue compacts the first turn away, and the retry fits. An earlier cap of
    // 8,000 sat below base-plus-one-result, and the retry re-overflowed on every attempt -- the
    // rescue working exactly as designed against a limit nothing could satisfy.
    await setCap({ relativeChars: 16_000 });
    console.log("  proxy cap: first prompt + 16,000 chars; overflow is answered with xAI's verbatim 400");
    transcriptBefore = spoken(await call("getAgentTranscript", { id: agentId })).length;
    let rejected = false;
    for (let i = 1; i <= MAX_TURNS && !rejected; i += 1) {
      const t = await turn(agentId, growthPrompt);
      const entries = await proxyLog();
      rejected = entries.some((e) => e.rejected === true);
      const last = entries.filter((e) => e.promptTokens != null).at(-1);
      console.log(`  growth turn ${i}: ${t.ok ? "answered" : "NO ANSWER"}; last accepted prompt ${last?.promptTokens ?? "?"} tokens${rejected ? "; provider REJECTED during this turn" : ""}`);
      if (rejected && !t.ok) {
        const rejections = entries.filter((e) => e.rejected === true).length;
        const compactedMeanwhile = await hostLogSince(marker, "conversation compacted");
        throw new Error(rejections > 1 && compactedMeanwhile
          ? `the turn never recovered: the rescue fired (${rejections} rejections, compaction ran) but every retry re-overflowed -- the cap sits below the base prompt plus one tool result, which compaction cannot shrink`
          : "the provider rejected the prompt and the turn never recovered -- the compact-and-retry rescue did not fire");
      }
      if (rejected) compacted = await hostLogSince(marker, "conversation compacted");
    }
    if (!rejected) throw new Error(`the proxy never rejected a prompt in ${MAX_TURNS} turns; the history did not reach the cap`);
    if (!compacted) throw new Error("the turn recovered but no '[sand][turn] conversation compacted' line appeared -- the rewrite did not happen");
    console.log(`  ${compacted.split("\n")[0].trim()}`);
    const transcriptAfter = spoken(await call("getAgentTranscript", { id: agentId })).length;
    if (transcriptAfter < transcriptBefore) throw new Error(`the transcript shrank from ${transcriptBefore} to ${transcriptAfter} messages -- compaction must never touch it`);
    console.log(`  transcript kept every turn: ${transcriptBefore} -> ${transcriptAfter} messages`);
    const spent = (await proxyLog()).reduce((sum, e) => sum + (e.promptTokens ?? 0), 0);
    console.log(`  prompt tokens sent through the proxy this run: ${spent}`);
    console.log("\nOK");
    exitCode = 0;
  } else {
  const first = await turn(agentId, smallPrompt);
  if (!first.ok) throw new Error("the first turn never answered; nothing below is testable");
  const base = (await proxyLog()).filter((e) => e.rejected === false && e.promptTokens != null).at(-1);
  if (base == null) throw new Error("the proxy saw no completed turn with usage; cannot size the test");
  console.log(`  base prompt: ${base.promptTokens} tokens, ${base.promptChars} chars`);
  transcriptBefore = spoken(await call("getAgentTranscript", { id: agentId })).length;
  {
    // Start threshold = window - 10,000; persist = window - 5,000. Sized so a handful of growth
    // turns cross both.
    const window = base.promptTokens + 24_000;
    await patchSecrets({ SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: window });
    console.log(`  context window set to ${window} (compaction starts at ${window - 10_000}, persists at ${window - 5_000})`);
    for (let i = 1; i <= MAX_TURNS && !compacted; i += 1) {
      const t = await turn(agentId, growthPrompt);
      const last = (await proxyLog()).filter((e) => e.promptTokens != null).at(-1);
      console.log(`  growth turn ${i}: ${t.ok ? "answered" : "NO ANSWER"}; last prompt ${last?.promptTokens ?? "?"} tokens`);
      compacted = await hostLogSince(marker, "conversation compacted");
    }
  }

  if (!compacted) throw new Error("no '[sand][turn] conversation compacted' line appeared in the host log -- the rewrite did not happen");
  console.log(`  ${compacted.split("\n")[0].trim()}`);

  const after = await turn(agentId, smallPrompt);
  if (!after.ok) throw new Error("the agent stopped answering after compaction");
  const transcriptAfter = spoken(await call("getAgentTranscript", { id: agentId })).length;
  if (transcriptAfter < transcriptBefore) throw new Error(`the transcript shrank from ${transcriptBefore} to ${transcriptAfter} messages -- compaction must never touch it`);
  console.log(`  transcript kept every turn: ${transcriptBefore} -> ${transcriptAfter} messages`);

  const spent = (await proxyLog()).reduce((sum, e) => sum + (e.promptTokens ?? 0), 0);
  console.log(`  prompt tokens sent through the proxy this run: ${spent}`);
  console.log("\nOK");
  exitCode = 0;
  }
} catch (error) {
  console.log(`\nFAILED — ${error.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
