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
// --send-cap swaps the stub's sentence for one constant line and measures LOOP-2 instead: the
// send cap and its duplicate suppressor count per TURN, not per model step. Every step after the
// first then repeats a message already delivered in the same turn, so the deployed host must
// deliver exactly one and refuse the rest with a [sand][send-cap] line. With the counters in the
// tool's own closure -- one tool per step -- each step got a fresh suppressor that had never seen
// the previous message, and all five went out.
//
// The default arm then runs a second phase on the same agent (QOL-NEEDS-YOU): the stub stops
// looping and answers like a real model -- one SendMessage, then plain text -- so the turn settles
// on a closing message. Closing on a question must raise awaitingUserResponse on the roster row
// within one console heartbeat (the amber "Waiting on you"), the operator's next message must
// clear it, and a turn that closes on a plain statement must not raise it at all.
//
// Usage: node scripts/verify-loop.mjs [--cap 5] [--send-cap] [--timeout-ms 60000] [--port 18777]
import { execFile } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// The LOOP-2 arm. The refusal the host hands back is a different tool result from the ack, so the
// self-talk streak restarts once and the turn runs one step longer than the plain arm.
const DUPLICATE = process.argv.includes("--send-cap");
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

// The console's heartbeat, from ui/machine-room/gateway-adapter.js: the roster is re-read every
// 15s, so "within one heartbeat" is the honest deadline for anything the sidebar must show.
const HEARTBEAT_MS = 15_000;
// AVATAR-1: the console draws a waiting agent as an excited crew member, which is the one mood
// nothing else on the page can raise. Reading it needs a real browser, and this gate is the only
// place a genuine awaitingUserResponse exists, so it is read here rather than faked elsewhere.
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------------------------------------------------------------- the looping stub
let toolRequests = 0;
let plainRequests = 0;
// QOL-NEEDS-YOU arm. Out of "loop" the stub stops looping and answers like a real turn: one
// SendMessage, then plain text so the turn settles on a closing message. "ask" closes with a
// question the host's classifier must catch; "quiet" closes with a statement it must leave alone.
// "quiet" carries a rhetorical question the agent answers itself, because that is what the first
// cut got wrong: it scanned every sentence backwards and put "Was anything else outstanding?" on
// the row while nothing was owed. Only the LAST sentence decides now, and this measures it live.
let stubMode = "loop";
let phaseSends = 0;
const setStubMode = (mode) => { stubMode = mode; phaseSends = 0; };
const PHASE_MESSAGE = {
  ask: "I pulled the report, but the vendor portal signed me out. Can you sign in on the box and tell me when you're through?",
  quiet: "Thanks, I'm through and the report is filed. Was anything else outstanding? No, that was the last of it.",
};
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
    if (stubMode !== "loop") {
      const first = offersSendMessage && phaseSends === 0;
      if (first) {
        phaseSends += 1;
        const args = JSON.stringify({ type: "text", content: PHASE_MESSAGE[stubMode] });
        sse(res, chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${stubMode}_${phaseSends}`, type: "function", function: { name: "SendMessage", arguments: args } }] }));
        sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      } else {
        plainRequests += 1;
        sse(res, chunk({ role: "assistant", content: "done" }));
        sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }
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
    const args = JSON.stringify({ type: "text", content: DUPLICATE ? "Standing by." : `Standing by, beat ${toolRequests}.` });
    sse(res, chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${toolRequests}`, type: "function", function: { name: "SendMessage", arguments: args } }] }));
    sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve, reject) => { stub.once("error", reject); stub.listen(PORT, "0.0.0.0", resolve); });
console.log(`  INFO  stub listening on 0.0.0.0:${PORT} (${DUPLICATE ? "LOOP-2 arm: one identical message every step" : "LOOP-1 arm: a new sentence every step"})`);

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
  if (DUPLICATE) {
    // The first send of the turn goes out -- the previous turn's identical message is forgotten,
    // as it must be -- and every repeat after it is refused for the rest of the turn.
    check(sends === 1, "exactly one message is delivered; the identical repeats later in the turn are refused", `saw ${sends}`);
    check(calls >= 2, "the model really got a second step, so a cross-step repeat happened", `${calls} tool-bearing model calls`);
  } else {
    check(sends === CAP, `exactly ${CAP} SendMessage rows`, `saw ${sends}`);
  }
  check(newNotices === 1, "the cap row is written once, and the host does not redrive the loop", `${newNotices} notice rows for this turn`);
  check(notices.some((n) => /cap/i.test(String(n.text ?? ""))), "a transcript row says the turn was ended on the cap");

  const logAfter = await docker(["exec", BOX, "sh", "-lc", `tail -n +${logBefore + 1} ${HOST_LOG}`]);
  const wire = logAfter.split("\n").filter((line) => line.includes("[sand][wire]") && line.includes(`"conversationId":"${agentId}"`));
  const wireCeiling = CAP + (DUPLICATE ? 2 : 1);
  check(wire.length <= wireCeiling, `the box stopped calling the model at ${wireCeiling} wire requests at most`, `${wire.length} for this conversation`);
  const capLine = logAfter.split("\n").filter((line) => line.includes("[sand][turn]") && /self-talk/i.test(line));
  check(capLine.length >= 1, "the host log names the cap", capLine[0]?.trim().slice(0, 160) ?? "no [sand][turn] self-talk line");
  if (DUPLICATE) {
    const sendCap = logAfter.split("\n").filter((line) => line.includes("[sand][send-cap]") && /duplicate/i.test(line));
    check(sendCap.length >= 1, "the host log names the send cap's duplicate suppressor", sendCap[0]?.trim().slice(0, 160) ?? "no [sand][send-cap] duplicate line");
  }

  // ------------------------------------------------ QOL-NEEDS-YOU: an agent waiting on the operator
  // A turn that ends by asking the operator for something (here: a sign-in only a person can do)
  // must raise awaitingUserResponse on the roster row, which is what the console draws as the
  // amber "Waiting on you" pill and counts as "N need you". Before this the flag was raised only
  // by a box hand-off or an auto-review approval, so a prose ask left the sidebar reading "Ready
  // for the next task" while the agent was blocked. The operator's next message clears it, and a
  // turn that closes on a plain statement must not raise it again.
  if (!DUPLICATE) {
    console.log("\n  ---- QOL-NEEDS-YOU: a turn that ends asking the operator ----");
    const agentRow = async () => (await gw("listAgents").catch(() => []))?.find?.((a) => a.id === agentId) ?? null;
    // One gateway read per tick answers both halves: lastMessagePreview says the closing message
    // landed, awaitingUserResponse says the badge went up. The gap between them is the measurement.
    const watch = async (windowMs, saw, done) => {
      const until = Date.now() + windowMs;
      const marks = { sawAt: 0, doneAt: 0, row: null };
      while (Date.now() < until) {
        const row = await agentRow();
        marks.row = row;
        if (row != null) {
          if (marks.sawAt === 0 && saw(row)) marks.sawAt = Date.now();
          if (marks.doneAt === 0 && done(row)) marks.doneAt = Date.now();
        }
        if (marks.doneAt !== 0 && marks.sawAt !== 0) break;
        await sleep(1000);
      }
      return marks;
    };

    const startRow = await agentRow();
    check(startRow != null && startRow.awaitingUserResponse == null, "the row starts with no awaiting badge", startRow == null ? "no roster row" : JSON.stringify(startRow.awaitingUserResponse));

    // The console, open on this box, for the length of both halves. A mood read is one attribute
    // off the agent's own roster card; the browser is a courtesy of this gate, not a dependency of
    // it, so a box with no playwright-core installed simply skips the two checks by name.
    let moodPage = null;
    let moodBrowser = null;
    try {
      const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
      moodBrowser = await chromium.launch({ executablePath: CHROME, headless: true });
      moodPage = await moodBrowser.newPage({ viewport: { width: 1440, height: 900 } });
      // Not networkidle: the console holds an open SSE stream, so the network is never idle, and
      // under this gate's own load the wait simply ran out. The roster card is the real signal.
      await moodPage.goto(`${GATEWAY}/`, { waitUntil: "domcontentloaded" });
      await moodPage.waitForSelector(`.worker-card[data-context-id="${agentId}"]`, { timeout: 60_000 });
    } catch (error) {
      moodPage = null;
      console.log(`  SKIP  the console's crew mood is not read this run — ${String(error.message).slice(0, 120)}`);
    }
    // Polls rather than reads once: the badge reaches the page on the console's own heartbeat, and
    // the mood follows the render that heartbeat drives.
    const moodOf = async (want, windowMs) => {
      if (!moodPage) return null;
      const until = Date.now() + windowMs;
      let seen = "";
      while (Date.now() < until) {
        seen = await moodPage.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"] [data-titan-mood]`)?.dataset.titanMood ?? "", agentId).catch(() => "");
        if (seen === want) return seen;
        await sleep(1000);
      }
      return seen;
    };

    setStubMode("ask");
    // Shaped as a question on purpose: an imperative here would trip the host's work redrive and
    // buy the turn extra model steps that have nothing to do with what is being measured.
    await gw("sendPrompt", { agentId, prompt: "Is the vendor portal reachable from the box?" });
    const raised = await watch(75_000, (row) => /sign in on the box/i.test(String(row.lastMessagePreview ?? "")), (row) => row.awaitingUserResponse != null);
    const reason = String(raised.row?.awaitingUserResponse?.reason ?? "");
    const lag = raised.doneAt !== 0 && raised.sawAt !== 0 ? raised.doneAt - raised.sawAt : null;
    console.log(`  INFO  closing message seen at +${raised.sawAt ? raised.sawAt - startedAt : "never"}ms, badge at +${raised.doneAt ? raised.doneAt - startedAt : "never"}ms`);
    check(raised.sawAt !== 0, "the agent delivered the closing ask", raised.sawAt !== 0 ? String(raised.row?.lastMessagePreview ?? "").slice(0, 120) : "no closing message in 75s");
    check(raised.doneAt !== 0, "the roster row says the agent is waiting on the operator", raised.doneAt !== 0 ? `awaitingUserResponse.tabId=${raised.row?.awaitingUserResponse?.tabId}` : "awaitingUserResponse stayed null");
    check(lag != null && lag <= HEARTBEAT_MS, "the badge is up within one console heartbeat of the message", lag == null ? "one of the two never happened" : `${lag}ms of ${HEARTBEAT_MS}ms`);
    check(/sign in/i.test(reason), "the badge quotes the sentence that asked", reason.slice(0, 140) || "no reason");
    // Not a box hand-off and not an auto-review approval: the tab id says the turn classifier is
    // what raised it, which is the whole point of this arm.
    check(raised.row?.awaitingUserResponse?.tabId === "turn-question", "the badge came from the closing-message classifier", String(raised.row?.awaitingUserResponse?.tabId ?? "none"));
    // AVATAR-1: needs-you drives excited on the roster card.
    const excitedAt = Date.now();
    const excited = await moodOf("excited", 40_000);
    if (excited == null) console.log("  SKIP  a waiting agent's crew member is excited on the roster card — not reached: no browser this run");
    else check(excited === "excited", "a waiting agent's crew member is excited on the roster card", `${excited || "no face on the card"} after ${Date.now() - excitedAt}ms`);

    // The clear. The stub stops asking first, so the turn this reply drives ends on a plain
    // statement -- which both clears the badge and proves a quiet close does not raise it again.
    setStubMode("quiet");
    const repliedAt = Date.now();
    await gw("sendPrompt", { agentId, prompt: "I'm signed in now." });
    const cleared = await watch(75_000, (row) => /report is filed/i.test(String(row.lastMessagePreview ?? "")), (row) => row.awaitingUserResponse == null);
    check(cleared.doneAt !== 0, "the operator's reply clears the badge", cleared.doneAt !== 0 ? `${cleared.doneAt - repliedAt}ms after the send` : "the badge never cleared");
    check(cleared.doneAt !== 0 && cleared.doneAt - repliedAt <= HEARTBEAT_MS, "cleared within one console heartbeat of the reply", cleared.doneAt === 0 ? "never cleared" : `${cleared.doneAt - repliedAt}ms of ${HEARTBEAT_MS}ms`);
    check(cleared.sawAt !== 0, "the follow-up turn delivered its closing statement", cleared.sawAt !== 0 ? String(cleared.row?.lastMessagePreview ?? "").slice(0, 120) : "no closing message in 75s");
    const after = await agentRow();
    check(after != null && after.awaitingUserResponse == null, "a turn that closes on a statement, rhetorical question and all, does not raise the badge", after == null ? "no roster row" : JSON.stringify(after.awaitingUserResponse));
    // And the face settles again. The six-second celebration for the delivered reply has to expire
    // first, so the window here is longer than the badge's own.
    const settled = await moodOf("calm", 30_000);
    if (settled == null) console.log("  SKIP  and it settles back to calm once the operator has answered — not reached: no browser this run");
    else check(settled === "calm", "and it settles back to calm once the operator has answered", settled || "no face on the card");
    if (moodBrowser) await moodBrowser.close().catch(() => {});
    setStubMode("loop");
  }
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
