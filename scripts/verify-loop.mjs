#!/usr/bin/env node
// verify-loop.mjs -- the self-talk cap gate (LOOP-1).
//
// An agent that keeps calling SendMessage and nothing else is talking to itself: every step
// costs a model call, nothing changes, and there is no interrupt on the gateway. This gate
// stands up a stub OpenAI-compatible server on this Mac that answers EVERY request with a
// SendMessage tool call carrying a new sentence -- the perfect looping model -- points the box
// at it, sends one turn, and asserts the runner stops on its own after the cap.
//
// Nothing here is permanent: the stub endpoint row is deleted and the endpoint that was live
// before is pinned back in a finally, whatever happened.
//
// Usage: node scripts/verify-loop.mjs [--cap 5] [--timeout-ms 60000] [--port 18777]
import { execFile } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const HOST_LOG = "/tmp/sand-host.log";
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const CAP = Number.parseInt(flag("--cap", "5"), 10);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "60000"), 10);
const PORT = Number.parseInt(flag("--port", "18777"), 10);
// The stub's own safety valve. Without the cap in the runner the turn never ends, so the stub
// stops feeding it tool calls well before the agent's 5000-step ceiling; the count it reached
// is the measurement.
const STUB_LIMIT = Number.parseInt(flag("--stub-limit", "30"), 10);
const STUB_ID = "probe-u3-loop";
const STUB_MODEL = "probe-u3-loop-model";

let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };

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
const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const relay = async (route, body) => {
  const res = await fetch(`${GATEWAY}${route}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${typeof parsed === "string" ? parsed.slice(0, 200) : parsed.error ?? ""}`);
  return parsed;
};
const docker = (args) => new Promise((resolve) => execFile("docker", args, { maxBuffer: 64 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the looping stub
let toolRequests = 0;
let plainRequests = 0;
const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
const chunk = (delta, finish = null) => ({
  id: "probe-loop", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: STUB_MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stub = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: STUB_MODEL, object: "model", max_model_len: 32_768, context_length: 32_768 }] }));
  }
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
    const offersSendMessage = (parsed.tools ?? []).some((tool) => (tool?.function?.name ?? tool?.name) === "SendMessage");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // A request with no SendMessage on offer is not the turn under test (a summarizer or a
    // classifier borrowing the same pinned endpoint): answer with plain text so it settles.
    if (!offersSendMessage || toolRequests >= STUB_LIMIT) {
      plainRequests += 1;
      sse(res, chunk({ role: "assistant", content: "done" }));
      sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    toolRequests += 1;
    const args = JSON.stringify({ type: "text", content: `Standing by, beat ${toolRequests}.` });
    sse(res, chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${toolRequests}`, type: "function", function: { name: "SendMessage", arguments: args } }] }));
    sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve, reject) => { stub.once("error", reject); stub.listen(PORT, "0.0.0.0", resolve); });
console.log(`  INFO  stub listening on 0.0.0.0:${PORT}`);

const reachable = (await docker(["exec", BOX, "sh", "-lc", `curl -s -m 5 -o /dev/null -w '%{http_code}' http://host.docker.internal:${PORT}/v1/models`])).trim();
check(reachable === "200", "the box reaches the stub on this Mac", `host.docker.internal:${PORT}/v1/models -> ${reachable || "no answer"}`);

// ---------------------------------------------------------------- pin the stub
const before = await relay("/endpoints");
const previous = (before.endpoints ?? []).find((e) => e.baseUrl === before.live?.baseUrl && e.model === before.live?.model)?.id ?? null;
// The catalog comes back with a probed `health` and a masked key; "set" is the token the relay
// swaps back for the stored one, so every existing row is written back exactly as it was.
const kept = (before.endpoints ?? []).filter((e) => e.id !== STUB_ID).map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
console.log(`  INFO  live endpoint before: ${previous ?? "unknown"} (${before.live?.model ?? "?"})`);

let agentId = null;
try {
  if (previous == null) throw new Error("could not identify the live endpoint; refusing to repin blindly");
  await relay("/endpoints", { endpoints: [...kept, { id: STUB_ID, name: "probe-u3-loop stub", baseUrl: `http://host.docker.internal:${PORT}/v1`, model: STUB_MODEL, apiKey: "" }] });
  const used = await relay("/endpoints/use", { id: STUB_ID });
  console.log(`  INFO  box now on ${used.using}`);

  const created = await gw("createAgent", { name: `probe-u3-loop-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
  agentId = created?.id ?? created?.agent?.id ?? null;
  if (agentId == null) throw new Error(`createAgent returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  await gw("openAgent", { id: agentId }).catch(() => {});

  const isSend = (entry) => entry.kind === "send-message";
  const isNotice = (entry) => entry.kind === "notice";
  const transcript = () => gw("getAgentTranscript", { id: agentId });
  const settle = async (windowMs, done) => {
    const until = Date.now() + windowMs;
    let entries = await transcript();
    while (Date.now() < until && !done(entries)) {
      await sleep(1500);
      entries = await transcript();
      if (toolRequests >= STUB_LIMIT) break;
    }
    return entries;
  };

  // A new agent opens the conversation on its own, and against this stub that opening turn loops
  // too. Let it hit the cap and settle first, so what is measured below is one turn and not two.
  const opening = await settle(45_000, (entries) => entries.some(isNotice));
  const openingSends = opening.filter(isSend).length;
  const openingNotices = opening.filter(isNotice).length;
  console.log(`  INFO  the agent's own opening turn: ${openingSends} send rows, ${openingNotices} notice rows, ${toolRequests} model calls so far`);
  await sleep(3000);

  const logBefore = Number.parseInt((await docker(["exec", BOX, "sh", "-lc", `wc -l < ${HOST_LOG} 2>/dev/null || echo 0`])).trim(), 10) || 0;
  const callsBefore = toolRequests;
  const before = await transcript();
  const sendsBefore = before.filter(isSend).length;
  const noticesBefore = before.filter(isNotice).length;
  const startedAt = Date.now();
  // Shaped as work on purpose: a turn that only talks when the user asked for something is what
  // the host would otherwise redrive, buying the loop another cap's worth of model calls.
  await gw("sendPrompt", { agentId, prompt: "Read the file /etc/hostname and tell me what is in it." });

  const entries = await settle(TIMEOUT_MS, (rows) => rows.filter(isNotice).length > noticesBefore);
  const sends = entries.filter(isSend).length - sendsBefore;
  const notices = entries.filter(isNotice);
  const newNotices = notices.length - noticesBefore;
  const calls = toolRequests - callsBefore;
  const elapsed = Date.now() - startedAt;

  console.log(`  INFO  this turn: ${calls} tool-bearing model calls, ${sends} send-message rows, ${newNotices} notice rows, ${elapsed}ms (${plainRequests} plain calls overall)`);
  for (const notice of notices.slice(-1)) console.log(`        notice: ${String(notice.text ?? "").slice(0, 160)}`);

  check(newNotices >= 1, "the turn ended on the cap inside the window", newNotices >= 1 ? `${elapsed}ms` : `no cap notice after ${elapsed}ms; the stub fed ${calls} SendMessage calls`);
  check(sends === CAP, `exactly ${CAP} SendMessage rows`, `saw ${sends}`);
  check(newNotices === 1, "the cap row is written once, and the host does not redrive the loop", `${newNotices} notice rows for this turn`);
  check(notices.some((n) => /cap/i.test(String(n.text ?? ""))), "a transcript row says the turn was ended on the cap");

  const logAfter = await docker(["exec", BOX, "sh", "-lc", `tail -n +${logBefore + 1} ${HOST_LOG}`]);
  const wire = logAfter.split("\n").filter((line) => line.includes("[sand][wire]") && line.includes(`"conversationId":"${agentId}"`));
  check(wire.length <= CAP + 1, `the box stopped calling the model at ${CAP + 1} wire requests at most`, `${wire.length} for this conversation`);
  const capLine = logAfter.split("\n").filter((line) => line.includes("[sand][turn]") && /self-talk/i.test(line));
  check(capLine.length >= 1, "the host log names the cap", capLine[0]?.trim().slice(0, 160) ?? "no [sand][turn] self-talk line");
} catch (error) {
  check(false, "self-talk cap", error.message);
} finally {
  if (agentId != null) await gw("deleteAgent", { id: agentId }).catch((error) => console.log(`  INFO  probe agent NOT deleted: ${error.message}`));
  await relay("/endpoints", { endpoints: kept }).catch((error) => console.log(`  INFO  catalog NOT restored: ${error.message}`));
  if (previous != null) await relay("/endpoints/use", { id: previous }).then(() => console.log(`  INFO  box restored to ${previous}`)).catch((error) => console.log(`  INFO  box NOT restored: ${error.message}`));
  await new Promise((resolve) => stub.close(resolve));
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
