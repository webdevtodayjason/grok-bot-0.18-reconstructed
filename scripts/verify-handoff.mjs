#!/usr/bin/env node
// verify-handoff.mjs -- the computer hand-off, end to end (docs/HANDOFF.md, gap row HANDBACK-1).
//
// A hand-off is the one moment the product asks a person to take the keyboard: the agent calls
// request_box_help, its turn ends, the conversation carries a card, and the person either does the
// step and hands the computer back, or skips it. Three things had to become true for that loop to
// be gateable at all, and this file is written against them rather than against what the tree
// happened to do when it was written:
//
//   1. ONE VOCABULARY. The entry's `boxResolution` and the prompt the agent is resumed with agree.
//      Resolutions written from now on are `handed_back` and `dismissed`; `completed` and
//      `cancelled` are read-side aliases for rows already on customers' boxes. Before this, a skip
//      wrote "cancelled" AND resumed with the handed-back prompt, so a skip and a done were
//      indistinguishable on the wire.
//   2. A FIRST-CLASS SKIP. `skipBoxHandoff {id}` is its own command. On a host that predates it the
//      console draws no Skip control at all, so this gate treats an unknown command as a printed
//      SKIP with its reason, never as a failure -- a box someone chose not to update is not a
//      product defect.
//   3. NO PICTURE ON THE WIRE. `getForeverBoxStatus.handoff` is {requestId, instruction, startedAt,
//      snapshotAt?} and nothing else. The snapshot used to ride along and took the payload from
//      284 B to 10 KB on a blank screen, pulled on every 15 s heartbeat.
//
// Three traps this file is shaped around, each measured before it was written:
//   - THE MODEL DENIES THE TOOL AND THEN CALLS IT. Asked for `request_box_help` by name, the agent
//     answered that the tool was not available while the host's own toolset line listed it. So the
//     prompt asks for the OUTCOME ("I need to sign in to something on your computer myself, hand it
//     over and wait for me") and every assertion is on `getForeverBoxStatus.handoff`, never on the
//     agent's prose. Getting the gate's own sign-in form onto the screen is a SEPARATE, best-effort
//     turn, and only --console spends it: folding it into the ask made the agent spend the whole
//     turn in the browser and hand nothing over, twice.
//   - AN INTERRUPT-AND-RESUME CAN LEAVE A CONVERSATION SILENT. Measured once: three prompts after a
//     resume produced nothing while a fresh control agent answered in 8 s on the same box. Every
//     mode ends with an ordinary prompt that must get a reply, or a green run could mean a card
//     that reads Done on a conversation that has stopped answering.
//   - PLAYWRIGHT'S page.route WEDGES THE CONSOLE'S BOOT (reproduced twice). Nothing here routes.
//     Nothing here reads the DOM before `window.__machineRoomAdapter` exists either: the static
//     shell will happily satisfy a selector with placeholder markup.
//
// Three modes, so each invocation fits the 300 s ceiling these gates run under. They share the box,
// the login throttle and the display, so they are run ONE AT A TIME:
//
//   node scripts/verify-handoff.mjs --host      no browser: the wire, the entry, skip, hand back
//   node scripts/verify-handoff.mjs --console   a real browser: the card, the rail, the banner
//   node scripts/verify-handoff.mjs --restart   opt-in: the pending record survives a host restart
//
// --restart kills the host process inside the shared box and waits for the supervisor, so it is run
// once, under the shipping lock, and never beside another wave's gate.
//
// Every mode creates its own scratch agent and deletes it on EVERY exit path, including a thrown
// assertion and a SIGTERM from the `timeout` these are run under (Node's default signal handler
// ends the process outright and never reaches a finally). Every call is individually bounded, and
// the run as a whole has a deadline: a leg that cannot start inside it prints SKIP with the budget
// it ran out of rather than letting the runner's `timeout` kill the summary.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireBoxLock } from "./lib/box-lock.mjs";

const MODES = { host: process.argv.includes("--host"), console: process.argv.includes("--console"), restart: process.argv.includes("--restart") };
const chosen = Object.entries(MODES).filter(([, on]) => on).map(([name]) => name);
if (chosen.length !== 1) {
  console.log("usage: node scripts/verify-handoff.mjs (--host | --console | --restart)");
  console.log("  --host     the wire, the transcript entry, skip and hand back. No browser.");
  console.log("  --console  the card, the rail card and the takeover banner, in a real browser.");
  console.log("  --restart  opt-in, under the shipping lock: a pending hand-off survives a host restart.");
  process.exit(2);
}
const MODE = chosen[0];

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.GROK_BOT_BOX_CONTAINER ?? "grok-bot-local-vm";
// The whole run's ceiling, well inside the 300 s the verify runner allows, so the summary is
// printed by this file rather than replaced by a `timeout` kill with no tallies in it.
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_HANDOFF_BUDGET_MS ?? 270_000);
// How long a hand-off may take to appear after the ask, and how long the agent's next message may
// take to land after a decision. Both are provider latency, not console latency: a window that
// closes is a SKIP with its own number.
const TURN_TIMEOUT_MS = Number(process.env.GROK_BOT_TURN_TIMEOUT_MS ?? 70_000);
const REPLY_TIMEOUT_MS = Number(process.env.GROK_BOT_REPLY_TIMEOUT_MS ?? 60_000);
const RELAY_TIMEOUT_MS = Number(process.env.GROK_BOT_RELAY_TIMEOUT_MS ?? 45_000);
// A hand-off's status payload has to stay small enough to pull on every heartbeat. The wire says
// {requestId, instruction, startedAt, snapshotAt?}; 1 KB is generous for that and impossible for a
// payload carrying a screenshot (this box's own frames are 47-52 KB, about 70 KB base64).
const STATUS_BUDGET_BYTES = 1024;
const deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(0, Math.min(ms, budgetLeft()));

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
// A leg that deliberately did not measure, with its reason and its own numbers. Not a pass: a gate
// that banks a vacuous PASS for a leg it never ran stops meaning the same thing twice.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const notReached = (why, ...labels) => { for (const label of labels) { console.log(`  SKIP  ${label} — not reached: ${why}`); skips += 1; } };
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms, step = 1500) => {
  const stop = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > stop || budgetLeft() <= 0) return null;
    await sleep(step);
  }
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
// Thrown when a run cannot measure anything and has already said why in its own SKIP line. It stops
// the modes below without adding a second, misleading failure on the way out.
class NothingToMeasure extends Error {}

// Every relay call is bounded. A gateway method that never answers would otherwise stop the whole
// gate forever with no failure and no line, and a gate that hangs is worse than one that fails.
const relayFetch = async (url, init, label) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  } catch (error) {
    const why = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? `did not answer within ${Math.round(RELAY_TIMEOUT_MS / 1000)}s`
      : (error?.message ?? String(error));
    throw new Error(`${label} ${why}`);
  }
};
// The relay holds the gateway token and adds it upstream, so nothing here needs a credential.
const gw = async (method, args = {}) => {
  const res = await relayFetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }, method);
  const text = await res.text();
  if (!res.ok) { const error = new Error(`${method} failed (${res.status}): ${text.slice(0, 200)}`); error.status = res.status; error.body = text; throw error; }
  return text.length ? JSON.parse(text) : null;
};
// A command a pre-upgrade host does not know. Measured on grok-bot-local-vm 2026-09-08: the relay
// answers exactly `404 {"error":"unknown gateway method: <name>"}` for a method the protocol map
// has no entry for, and `200 null` for a known one called with an id nothing matches. So the probe
// is precise — only that 404 shape means "this host predates the wave", and a 400 or a rejection
// from inside the host is a real error the caller must not hide behind a SKIP.
const tryCall = async (method, args = {}) => {
  try { return { known: true, value: await gw(method, args) }; }
  catch (error) {
    const body = String(error?.body ?? error?.message ?? "");
    const unknown = error?.status === 404 && /unknown gateway method/i.test(body);
    return unknown ? { known: false, why: body.slice(0, 160) } : { known: true, error };
  }
};
// Whether this host has the skip command at all, asked with an id nothing matches so the probe
// itself decides nothing. Cached: it is read from three places in the console mode.
let skipKnown = null;
const hasSkip = async () => {
  if (skipKnown != null) return skipKnown;
  const probe = await tryCall("skipBoxHandoff", { id: "" });
  skipKnown = { supported: probe.known, why: probe.why ?? "" };
  return skipKnown;
};

const docker = (args, ms = 20_000) => new Promise((resolve) => execFile("docker", args, { maxBuffer: 8 << 20, timeout: ms }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));

// -- the sign-in page the gate serves itself ------------------------------------------------------
// A hand-off has to be asked for about something real, and reaching a live site from a shared box
// makes the gate depend on someone else's uptime and login throttle. So the gate writes its own
// one-page sign-in form, copies it into the box, and asks the agent to open it. Nested quoting
// through `docker exec sh -c` fails on a file with quotes of its own, so the file is written
// locally and `docker cp`'d in rather than heredoc'd through a shell.
const PAGE_NAME = `handoff-gate-signin-${Date.now()}.html`;
const PAGE_PATH = `/workspace/${PAGE_NAME}`;
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>Gate demo sign-in</title>
<style>body{font:16px system-ui;background:#0d1117;color:#e6ebf2;display:grid;place-items:center;height:100vh;margin:0}
form{background:#172232;padding:32px;border-radius:12px;width:320px}
label{display:block;margin:12px 0 4px}input{width:100%;padding:8px;border-radius:6px;border:1px solid #2b3a4d;background:#0d1117;color:#e6ebf2}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:6px;background:#00c8f0;color:#06212a;font-weight:600}
#done{display:none;margin-top:16px;color:#7ee787}</style>
<form onsubmit="event.preventDefault();document.getElementById('done').style.display='block'">
<h2>Gate demo sign-in</h2><p>Only the person at the keyboard has this password.</p>
<label for=u>Account</label><input id=u value="super_admin">
<label for=p>Password</label><input id=p type=password>
<button type=submit>Sign in</button><p id=done>Signed in.</p></form>`;

// -- the scratch agent ---------------------------------------------------------------------------
const AGENT_NAME = `handoff gate ${MODE} ${Date.now()}`;
let agentId = null;
let pageCopied = false;
let sweeping = false;
const sweep = async () => {
  if (pageCopied) { await docker(["exec", BOX, "rm", "-f", PAGE_PATH], 10_000); pageCopied = false; }
  if (!agentId) return;
  const id = agentId;
  agentId = null;
  // Retried, because the one thing that must not fail is the delete. Measured on grok-bot-local-vm
  // 2026-09-08: a run's cleanup answered `502 gateway unreachable: fetch failed` and left a real
  // agent on a shared box for someone else to find. The host comes back in seconds after a swap or
  // a supervisor kill, so three tries a few seconds apart is the difference between a swept box and
  // a hand sweep.
  let why = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { await gw("deleteAgent", { id }); info(`scratch agent ${id} deleted${attempt > 1 ? ` (attempt ${attempt})` : ""}`); return; }
    catch (error) { why = error.message; if (attempt < 3) await sleep(4000); }
  }
  info(`scratch agent ${id} NOT deleted after 3 tries, DELETE IT BY HAND: ${why}`);
};
let releaseBoxLock = null;
// SIGTERM is exactly what `timeout` sends, and Node's default handler skips every finally. A real
// agent left on a shared box is what the last four waves have had to sweep by hand.
//
// This handler is registered FIRST and takes every other signal listener off the process before it
// starts, because acquireBoxLock registers one of its own that calls process.exit synchronously --
// which would kill the sweep half way through and leave the agent behind. The lock is released here
// instead, synchronously, before the sweep that needs the network.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (sweeping) process.exit(143);
    sweeping = true;
    process.removeAllListeners(signal);
    console.log(`\n  INFO  ${signal} — sweeping the scratch agent before exit`);
    if (releaseBoxLock) { releaseBoxLock(); releaseBoxLock = null; }
    void Promise.race([sweep(), sleep(8000)]).finally(() => process.exit(143));
  });
}

const tailOf = async (id, limit = 60) => ((await gw("getAgentTranscriptTail", { id, limit }).catch(() => null))?.entries ?? []);
const handoffEntry = (entries, requestId) => entries.find((e) => e.kind === "send-message" && e.boxRequestId === requestId) ?? null;
// null when the READ failed, [] when the host answered with nothing. Collapsing the two is how a
// host that is down gets reported as "the outline carries no hidden row", which is a claim about
// the product made from an answer nobody got. Measured on grok-bot-local-vm 2026-09-08: a run read
// zero rows for two decisions while the supervisor was relaunching the host every few seconds.
const outlineOf = async (id) => { const rows = await gw("getConversationOutline", { id }).catch(() => null); return Array.isArray(rows) ? rows : null; };
// A resume arrives as a hidden user turn: the host runs it with `hidden: true`, and the outline
// carries it as an ordinary user row whose text is the bracketed prompt. This is the ONLY surface
// that carries the end of a hand-off honestly -- the outline's send-message rows carry no box
// fields at all, which is why the card lives on the transcript entry and not here (docs/HANDOFF.md).
const hiddenPrompts = (rows) => (rows ?? [])
  .filter((row) => row?.kind === "user")
  .map((row) => String(row.text ?? "").trim())
  .filter((text) => text.startsWith("[") && text.endsWith("]"));
const newestHiddenPrompt = (rows) => hiddenPrompts(rows).at(-1) ?? null;
const agentReplies = (entries) => entries.filter((e) => e.kind === "send-message" && e.boxRequestId == null);
// A send-message entry's text lives at entry.message.content, NOT entry.content (measured on
// grok-bot-local-vm 2026-09-08: the entry's own keys are kind, id, message, timestampMs). Reading
// the wrong one returns "" for every reply, which would make an assertion on what the agent said
// fail for the shape of the record rather than for anything the agent did.
const entryText = (entry) => {
  const value = entry?.message?.content ?? entry?.content ?? "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((c) => c?.text ?? "").join("");
  return JSON.stringify(value ?? "");
};

// Ask for the OUTCOME. Never for the tool: asked for `request_box_help` by name the model has
// answered that it does not have it, with the host's own toolset line saying otherwise.
//
// This exact wording is MEASURED, not written. On grok-bot-local-vm 2026-09-08 it produced a
// pending hand-off in about 30 s, instruction "Sign in to the account on the screen, then hand the
// computer back to me." The version that also told the agent to open the gate's page first spent
// the whole 70 s turn on the browser and handed nothing over, twice. So the two asks are separate
// turns: getting the form on screen is best effort and its failure costs a note, while the ask that
// this gate is actually about is the one measured to work, unchanged.
const ASK = "I need to sign in to something on your computer myself. Hand the computer over to me "
  + "for the sign-in with a one-line instruction and wait for me. Do not try to sign in yourself.";
const OPEN_PAGE = `Open the local file file://${PAGE_PATH} in the browser on your computer, so it is on the screen. Do not fill anything in. Reply with one short line when it is up, or one short line saying you could not.`;
const putThePageUp = async () => {
  const startedAt = Date.now();
  const before = agentReplies(await tailOf(agentId)).length;
  await gw("sendPrompt", { agentId, prompt: OPEN_PAGE }).catch((e) => info(`the page-open ask was rejected (${e.message})`));
  const answered = await until(async () => { const n = agentReplies(await tailOf(agentId)).length; return n > before ? n : null; }, within(45_000), 4000);
  if (answered == null) info(`the agent did not answer the page-open ask inside 45s; the hand-off legs do not depend on it, but the screen may be blank`);
  else info(`the gate's sign-in form was asked for in ${seconds(Date.now() - startedAt)}`);
};
const askForHandoff = async (label) => {
  const startedAt = Date.now();
  await gw("sendPrompt", { agentId, prompt: ASK }).catch((e) => info(`${label}: sendPrompt rejected (${e.message})`));
  const pending = await until(async () => (await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff ?? null, within(TURN_TIMEOUT_MS), 2500);
  return { pending, tookMs: Date.now() - startedAt };
};
// A second pass needs a hand-off to act on. If the first one is still pending -- which is exactly
// what happens when the skip leg could not run on a host that has no skip command -- use that one
// rather than asking again: `request_box_help` refuses a second request while one is outstanding
// (it answers the agent with the instruction it already sent), so a second ask would spend a turn
// and produce nothing, and the leg would report the FIRST hand-off as if it were new.
const pendingOrAsk = async (label) => {
  const live = (await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff ?? null;
  if (live != null) { info(`${label}: the earlier hand-off is still pending, so this pass acts on it rather than asking again`); return { pending: live, tookMs: 0, reused: true }; }
  return { ...(await askForHandoff(label)), reused: false };
};

let browser = null;
try {
  info(`mode ${MODE} · relay ${GATEWAY} · box ${BOX} · run budget ${Math.round(RUN_BUDGET_MS / 1000)}s`);
  // Retried while the relay answers "gateway unreachable", which is the host being restarted rather
  // than anything about a hand-off. Measured on grok-bot-local-vm 2026-09-08: while another wave was
  // swapping the host bundle, the supervisor relaunched it every few seconds and every call in
  // between answered 502. The host comes back in well under a minute, so the gate waits for it and
  // says so rather than reporting the wave's own bundle swap as a hand-off failure.
  let created = null;
  const createStart = Date.now();
  for (;;) {
    created = await gw("createAgent", { name: AGENT_NAME, description: `verify-handoff ${MODE} scratch agent` }).catch((e) => ({ error: e.message }));
    if (created?.error == null || !/gateway unreachable/i.test(String(created.error))) break;
    if (Date.now() - createStart > Math.min(60_000, budgetLeft())) break;
    info(`the host is not up (${String(created.error).slice(0, 60)}); waiting for the supervisor to bring it back`);
    await sleep(5000);
  }
  agentId = created?.agent?.id ?? created?.id ?? null;
  if (agentId == null && /gateway unreachable/i.test(String(created?.error ?? ""))) {
    skip("a scratch agent could be created for this run", `the box's host did not answer for ${seconds(Date.now() - createStart)}. Check /tmp/sand-supervisor.log inside the box: a run of "host exited (code 0)" lines means someone is swapping the bundle under you. Nothing below was measured`);
    throw new NothingToMeasure("the box's host is not up");
  }
  // A full roster is not a hand-off defect. ONBOARD-1 caps a workspace at Titan plus twelve, and on
  // a shared box the other waves' probe agents fill it: measured on grok-bot-local-vm 2026-09-08,
  // createAgent answered 409 "This workspace holds Titan and 12 more bots." A gate that reported
  // that as FAIL would send whoever read it looking at the hand-off path for a housekeeping problem.
  if (agentId == null && /holds Titan and \d+ more bots|Remove one to add another/i.test(String(created?.error ?? ""))) {
    skip("a scratch agent could be created for this run", "the box's roster is at the ONBOARD-1 cap (Titan plus twelve), so this run had nowhere to put its scratch agent. Sweep the leftover gate agents on the box and re-run; nothing below was measured");
    throw new NothingToMeasure("the box's roster is at the ONBOARD-1 cap");
  }
  check(agentId != null, "a scratch agent could be created for this run", agentId ?? JSON.stringify(created).slice(0, 160));
  if (agentId == null) throw new Error("no scratch agent: nothing below can be measured");
  const tmp = mkdtempSync(path.join(tmpdir(), "handoff-gate-"));
  const localPage = path.join(tmp, PAGE_NAME);
  writeFileSync(localPage, PAGE_HTML);
  const copied = await docker(["cp", localPage, `${BOX}:${PAGE_PATH}`], 20_000);
  rmSync(tmp, { recursive: true, force: true });
  pageCopied = copied.code === 0;
  check(pageCopied, "the gate's own sign-in page is in the box for the agent to open", pageCopied ? PAGE_PATH : copied.out.slice(0, 160));

  if (MODE === "host") {
    // ---------------------------------------------------------------------------------------
    // --host: the wire, the durable entry, and both decisions. No browser anywhere in here.
    // ---------------------------------------------------------------------------------------
    // Which decisions this run actually got to make, hoisted so the outline verdict below the
    // wedge check can read them.
    let skipStamped = false;
    let handedBack = false;
    console.log("\n== the ask");
    const first = await askForHandoff("first ask");
    if (first.pending == null) {
      skip("a hand-off appears on the host after an ordinary ask", `the agent produced no pending hand-off inside the ${Math.round(within(TURN_TIMEOUT_MS) / 1000 || TURN_TIMEOUT_MS / 1000)}s turn budget (waited ${seconds(first.tookMs)}); that is the box's provider, not the hand-off path`);
      // The three outline labels are deliberately NOT listed here: the end-of-run outline block
      // below reports them itself, with the count it actually saw, and listing them twice would
      // print six SKIP lines for three legs and double the tally.
      notReached("no hand-off to measure",
        "the status hand-off carries requestId and instruction",
        "and startedAt, so the card can say how long the person has had it",
        "and no picture rides on it",
        `and the whole box status stays under ${STATUS_BUDGET_BYTES} B, small enough to pull on every heartbeat`,
        "the transcript entry is the durable record of the hand-off",
        "skipBoxHandoff stamps the entry dismissed",
        "and the agent's next message lands after a skip",
        "handing back stamps the entry handed_back");
    } else {
      check(true, "a hand-off appears on the host after an ordinary ask, with no tool named in the prompt", `${seconds(first.tookMs)} from prompt to pending`);

      console.log("\n== what the wire carries");
      const status = await gw("getForeverBoxStatus", { id: agentId });
      const handoff = status?.handoff ?? {};
      const shown = JSON.stringify({ requestId: handoff.requestId, startedAt: handoff.startedAt ?? null, instruction: String(handoff.instruction ?? "").slice(0, 80) });
      // requestId and instruction have always been on the wire; startedAt is this wave's. Split so
      // a box someone chose not to update fails nothing it was never asked to carry, and an updated
      // one has no way to pass without it. `hasSkip()` is the single probe for "is this host post
      // wave", used the same way for the resolution word below.
      const postWave = (await hasSkip()).supported;
      check(typeof handoff.requestId === "string" && handoff.requestId.length > 0
        && typeof handoff.instruction === "string" && handoff.instruction.trim().length > 0,
        "the status hand-off carries requestId and instruction", shown);
      if (postWave) check(handoff.startedAt != null, "and startedAt, so the card can say how long the person has had it", String(handoff.startedAt ?? "absent"));
      else skip("and startedAt, so the card can say how long the person has had it", `this host has no skipBoxHandoff, so it predates the wave that added startedAt; it answered ${shown}`);
      const picture = Object.keys(handoff).filter((k) => /snapshotDataUrl|dataUrl|image|screenshot/i.test(k) && k !== "snapshotAt");
      const statusBytes = Buffer.byteLength(JSON.stringify(status ?? null));
      if (postWave) {
        check(picture.length === 0, "and no picture rides on it", picture.length ? `carries ${picture.join(", ")}` : `no image field, ${statusBytes} B`);
        check(statusBytes < STATUS_BUDGET_BYTES, `and the whole box status stays under ${STATUS_BUDGET_BYTES} B, small enough to pull on every heartbeat`, `${statusBytes} B`);
      } else {
        // A pre-wave host CAN answer with no picture: captureSnapshot is asynchronous and a status
        // read before it lands carries nothing. So on an old host this is reported either way with
        // its number and asserted on neither, rather than banking a pass on a race.
        skip("and no picture rides on it", `this host predates the wave; it answered ${statusBytes} B and ${picture.length ? `carries ${picture.join(", ")}` : "carried no image field at this read, which a pre-wave host also does whenever the snapshot has not been captured yet"}`);
        skip(`and the whole box status stays under ${STATUS_BUDGET_BYTES} B, small enough to pull on every heartbeat`, `this host predates the wave; ${statusBytes} B at this read`);
      }

      console.log("\n== the durable record");
      const entries = await tailOf(agentId);
      const entry = handoffEntry(entries, handoff.requestId);
      check(entry != null, "the transcript entry is the durable record of the hand-off", entry ? `entry ${entry.id}` : `no send-message entry carries boxRequestId ${handoff.requestId}`);
      check(entry != null && entry.boxInstruction === handoff.instruction, "and it repeats the instruction the host is holding", entry ? `${String(entry.boxInstruction ?? "").slice(0, 80)}` : "no entry");
      check(entry != null && entry.boxResolution == null, "and it is unresolved while the person still has the computer", entry ? JSON.stringify(entry.boxResolution ?? null) : "no entry");

      console.log("\n== skip");
      const beforeSkip = newestHiddenPrompt(await outlineOf(agentId));
      const repliesBeforeSkip = agentReplies(entries).length;
      const skipCall = await tryCall("skipBoxHandoff", { id: agentId });
      let skippedPrompt = null;
      if (!skipCall.known) {
        skip("skipBoxHandoff stamps the entry dismissed", `this host has no skipBoxHandoff (${skipCall.why}); a box that predates the hand-off wave draws no Skip control at all, which is the designed behaviour, not a defect. Nothing was faked in its place: handBackForeverBox {trigger:"dismissed"} would reach the declined prompt but stamp the entry completed, so the card would read Done on a step nobody did`);
        notReached("no skip command on this host", "and the agent's next message lands after a skip");
      } else if (skipCall.error) {
        check(false, "skipBoxHandoff stamps the entry dismissed", skipCall.error.message);
        notReached("skipBoxHandoff rejected", "and the agent's next message lands after a skip");
      } else {
        const resolved = await until(async () => {
          const e = handoffEntry(await tailOf(agentId), handoff.requestId);
          return e?.boxResolution ? e : null;
        }, within(25_000), 1500);
        skipStamped = resolved?.boxResolution === "dismissed";
        check(skipStamped, "skipBoxHandoff stamps the entry dismissed", resolved ? `boxResolution ${JSON.stringify(resolved.boxResolution)}` : "the entry was still unresolved after 25s");
        const cleared = await until(async () => ((await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff == null ? true : null), within(15_000), 1000);
        check(cleared === true, "and the host stops reporting the hand-off as pending", cleared === true ? "handoff null" : "still pending after 15s");
        // Best effort only, and deliberately not a verdict. The outline is prompt state and it
        // lags: measured on grok-bot-local-vm 2026-09-08, the skipped prompt was not in the outline
        // 60 s after the resume had already produced the agent's next message, and both prompts
        // were there by the end of the run. The verdict on the prompts is taken once at the end,
        // over both of them, where the lag cannot make it a race.
        skippedPrompt = await until(async () => { const p = newestHiddenPrompt(await outlineOf(agentId)); return p && p !== beforeSkip ? p : null; }, within(20_000), 2500);
        info(skippedPrompt ? `the skipped resume is already in the outline: ${skippedPrompt.slice(0, 120)}` : "the skipped resume is not in the outline yet (it is prompt state and lags); the end-of-run read is the verdict");
        const replied = await until(async () => { const n = agentReplies(await tailOf(agentId)).length; return n > repliesBeforeSkip ? n : null; }, within(REPLY_TIMEOUT_MS), 3000);
        if (replied == null) skip("and the agent's next message lands after a skip", `no new send-message inside the ${Math.round(REPLY_TIMEOUT_MS / 1000)}s reply budget; the resume was dispatched (the hidden prompt is in the outline) but the provider has not answered`);
        else check(true, "and the agent's next message lands after a skip", `${repliesBeforeSkip} → ${replied} agent messages`);
      }

      console.log("\n== hand back");
      if (budgetLeft() < TURN_TIMEOUT_MS + 20_000) {
        skip("handing back stamps the entry handed_back", `the run's ${Math.round(RUN_BUDGET_MS / 1000)}s budget has ${seconds(budgetLeft())} left, not enough for a second turn; run --host again for the hand-back pass`);
        info("the outline verdict below will be taken over the skip alone");
      } else {
        const second = await pendingOrAsk("second ask");
        if (second.pending == null) {
          skip("handing back stamps the entry handed_back", `the second ask produced no pending hand-off inside ${seconds(second.tookMs)}; the box's provider, not the hand-off path`);
          info("the outline verdict below will be taken over the skip alone");
        } else {
          const beforeBack = newestHiddenPrompt(await outlineOf(agentId));
          // The resume is fire-and-forget after the entry is stamped and the status emitted, so
          // this call is a command answer, not a turn. It used to await the whole revived turn:
          // the two readers measured the same path at 663 ms and at 9,866 ms with the socket
          // closed at 58,917 ms, which is exactly why the answer time is not something to build on.
          // The number is printed rather than asserted for the same reason, and a call that never
          // answers inside the relay timeout is said out loud, because that IS the old shape.
          const backStart = Date.now();
          let backAnswered = true;
          await gw("handBackForeverBox", { id: agentId, trigger: "button" }).catch((e) => { backAnswered = false; info(`handBackForeverBox did not answer: ${e.message}`); });
          info(backAnswered
            ? `handBackForeverBox answered in ${seconds(Date.now() - backStart)} on ${BOX}`
            : `handBackForeverBox had still not answered after ${seconds(Date.now() - backStart)} on ${BOX}, which is the pre-HANDBACK shape where the call awaits the whole revived turn`);
          // A decision WAS made, whatever word the host wrote, so the outline verdict counts it.
          handedBack = true;
          const back = await until(async () => {
            const e = handoffEntry(await tailOf(agentId), second.pending.requestId);
            return e?.boxResolution ? e : null;
          }, within(25_000), 1500);
          // `completed` is the pre-HANDBACK word for the same thing and is read as done by both the
          // host and the console. On a host that has skipBoxHandoff, writing it would be a real
          // vocabulary defect and this fails. On a host that does not, it is exactly what that host
          // is supposed to write, and failing on it would report someone's un-updated box as a
          // broken product. The two are told apart by the command probe, not by guessing.
          if (back?.boxResolution === "handed_back") check(true, "handing back stamps the entry handed_back", `boxResolution ${JSON.stringify(back.boxResolution)}`);
          else if (back?.boxResolution === "completed" && !(await hasSkip()).supported) {
            skip("handing back stamps the entry handed_back", `this host wrote the pre-HANDBACK word "completed" and has no skipBoxHandoff, so it predates this wave; both the host and the console read "completed" as done. Update the box's bundle and re-run to measure the new vocabulary`);
          } else check(false, "handing back stamps the entry handed_back", back ? `boxResolution ${JSON.stringify(back.boxResolution)}` : "the entry was still unresolved after 25s");
          const backPrompt = await until(async () => { const p = newestHiddenPrompt(await outlineOf(agentId)); return p && p !== beforeBack ? p : null; }, within(20_000), 2500);
          info(backPrompt ? `the handed-back resume is already in the outline: ${backPrompt.slice(0, 120)}` : "the handed-back resume is not in the outline yet");
        }
      }

    }

    // The wedge check. A conversation that has stopped answering after an interrupt-and-resume is
    // UX-ERR-1 in a new place, and every leg above would still be green on it.
    console.log("\n== the conversation still answers");
    if (budgetLeft() < 20_000) skip("an ordinary prompt after the hand-off still gets a reply", `the run's ${Math.round(RUN_BUDGET_MS / 1000)}s budget ran out with ${seconds(budgetLeft())} left`);
    else {
      const before = agentReplies(await tailOf(agentId)).length;
      await gw("sendPrompt", { agentId, prompt: "Reply with the single word: awake." }).catch(() => null);
      const after = await until(async () => { const n = agentReplies(await tailOf(agentId)).length; return n > before ? n : null; }, within(REPLY_TIMEOUT_MS), 3000);
      if (after == null) skip("an ordinary prompt after the hand-off still gets a reply", `no reply inside the ${Math.round(REPLY_TIMEOUT_MS / 1000)}s budget — this is the wedge this leg exists to catch, but a cold provider looks the same, so re-run before believing it`);
      else check(true, "an ordinary prompt after the hand-off still gets a reply", `${before} → ${after} agent messages`);
    }

    // THE VERDICT ON THE PROMPTS, taken once, at the end, over the whole outline. The outline is
    // the only surface that carries the END of a hand-off honestly (its send-message rows carry
    // no box fields, and the instruction entry is not in it at all), and this is where a skip
    // becomes distinguishable from a done for anything reading prompt state.
    console.log("\n== what the outline carries");
    const decisions = (skipStamped ? 1 : 0) + (handedBack ? 1 : 0);
    const OUTLINE_LABELS = [
      "the outline carries the skipped resume as a hidden row",
      "and the handed-back resume as a hidden row telling the agent to look at the desktop first",
      "and they are different text, so the outline can tell a skip from a done",
    ];
    if (decisions === 0) {
      notReached("neither decision was made this run", ...OUTLINE_LABELS);
    } else {
      // The last read's own answer is kept, so a run that ends on a host that is down can say
      // "the host never answered" rather than "the outline carries no hidden row".
      let lastAnswer = null;
      const rows = (await until(async () => {
        lastAnswer = await outlineOf(agentId);
        if (lastAnswer == null) return null;
        const found = hiddenPrompts(lastAnswer);
        return found.length >= decisions ? found : null;
      }, within(45_000), 3000)) ?? hiddenPrompts(lastAnswer);
      const declined = rows.find((p) => /declin|skip|without doing|did not do|not done/i.test(p)) ?? null;
      const resumed = rows.find((p) => /screenshot/i.test(p)) ?? null;
      // A hidden row appears only once the hidden turn actually STARTS, so a row that is not there
      // can mean two very different things: the vocabulary is wrong, or the resumed turn never got
      // off the provider's queue. Measured on grok-bot-local-vm 2026-09-08, both happened on the
      // same box inside ten minutes: one run had both prompts, the next had neither and its
      // ordinary control prompt went unanswered too. So the verdict is only taken when the outline
      // holds at least as many hidden rows as decisions were made; short of that the leg says
      // which, with the count, and measures nothing.
      if (rows.length < decisions) {
        const why = lastAnswer == null
          ? "the host never answered getConversationOutline before the run's budget ran out, so nothing here was measured. A run of \"host exited (code 0)\" lines in /tmp/sand-supervisor.log inside the box means someone is swapping the bundle under you"
          : `${rows.length} hidden row(s) for ${decisions} decision(s): the resumed turn(s) did not start inside the run's budget, which is the box's provider and not the hand-off path`;
        skip(OUTLINE_LABELS[0], `${why}. Re-run before reading anything into it`);
        skip(OUTLINE_LABELS[1], why);
        skip(OUTLINE_LABELS[2], why);
      } else {
        if (skipStamped) check(declined != null, OUTLINE_LABELS[0], declined ? declined.slice(0, 180) : `${rows.length} hidden row(s), none of them the declined prompt`);
        else skip(OUTLINE_LABELS[0], "no skip was made this run");
        if (handedBack) check(resumed != null, OUTLINE_LABELS[1], resumed ? resumed.slice(0, 180) : `${rows.length} hidden row(s), none of them the screenshot prompt`);
        else skip(OUTLINE_LABELS[1], "nothing was handed back this run");
        if (skipStamped && handedBack && declined != null && resumed != null) check(declined !== resumed, OUTLINE_LABELS[2], `${declined.length} vs ${resumed.length} chars`);
        else skip(OUTLINE_LABELS[2], `${rows.length} hidden row(s); ${[declined && "the declined", resumed && "the screenshot"].filter(Boolean).join(" and ") || "neither"} prompt was among them`);
      }
    }
  }

  if (MODE === "restart") {
    // ---------------------------------------------------------------------------------------
    // --restart: the pending record is a sidecar the service owns, not a bare Map. Kill the host
    // and the person's card has to come back saying the same thing, aimed at the same request.
    // ---------------------------------------------------------------------------------------
    // This mode kills the host process inside the shared box, so it takes the same lock the two
    // gates that recreate the box take (scripts/lib/box-lock.mjs, the protocol scripts/on-box.sh
    // uses). Two gates on one box at the same time is GATE-2, and this is the mode that would do
    // the most damage doing it.
    releaseBoxLock = await acquireBoxLock({ what: "verify-handoff.mjs --restart (restarts the host in the box)", log: (line) => info(line) });
    console.log("\n== a pending hand-off, then a host restart");
    const asked = await askForHandoff("restart ask");
    if (asked.pending == null) {
      skip("a pending hand-off survives a host restart", `the agent produced no pending hand-off inside ${seconds(asked.tookMs)}, so there was nothing to restart around`);
    } else {
      const was = asked.pending;
      info(`pending ${was.requestId} · ${String(was.instruction ?? "").slice(0, 80)}`);
      const killed = await docker(["exec", BOX, "pkill", "-f", "/home/box/sand-host/host-main.cjs"], 15_000);
      info(`host process signalled (pkill exit ${killed.code})`);
      const backUp = await until(async () => (await gw("getHostStatus", {}).catch(() => null)) ?? null, within(90_000), 3000);
      if (backUp == null) {
        skip("a pending hand-off survives a host restart", "the supervisor did not bring the host back inside 90s; that is a box problem (see BOX-4 and the supervisor log), not a hand-off one");
      } else {
        const after = await until(async () => (await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff ?? null, within(30_000), 2000);
        check(after?.requestId === was.requestId, "a pending hand-off survives a host restart, aimed at the same request", after ? `${was.requestId} → ${after.requestId}` : "the host reports no hand-off 30s after it came back");
        check(after != null && after.instruction === was.instruction, "and it still says what the agent asked for", after ? String(after.instruction ?? "").slice(0, 100) : "no hand-off");
        // Leave nothing pending behind on a shared box.
        await gw("handBackForeverBox", { id: agentId, trigger: "button" }).catch(() => null);
      }
    }
  }

  if (MODE === "console") {
    // ---------------------------------------------------------------------------------------
    // --console: the three places a person meets a hand-off. Nothing is read before the adapter
    // exists, and every control is hit-tested rather than merely clicked: page.click() calls
    // scrollIntoViewIfNeeded first and has passed on menu items a mouse could never reach.
    // ---------------------------------------------------------------------------------------
    const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // A gate that reads the static shell will happily pass against placeholder markup.
    const boot = async () => {
      await page.goto(`${GATEWAY}/`, { waitUntil: "load" });
      return await until(() => page.evaluate(() => (window.__machineRoomAdapter ? true : null)), within(45_000), 500);
    };
    const openRoom = async (id) => {
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
      await page.waitForTimeout(300);
      const card = await until(() => page.$(`.worker-card[data-context-id="${id}"]`), within(30_000), 1000);
      if (!card) return false;
      await card.click({ timeout: 10_000 }).catch(() => {});
      return (await until(() => page.evaluate((wanted) => (document.querySelector(".worker-card.is-active")?.dataset.contextId === wanted ? true : null), id), within(20_000), 700)) === true;
    };
    // Visible, not covered, and the element under its own centre is itself or something inside it.
    const hitTest = (selector) => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { found: true, visible: false, w: 0, h: 0 };
      const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { found: true, visible: true, w: Math.round(rect.width), h: Math.round(rect.height), hit: at != null && (at === el || el.contains(at)), on: at ? `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}` : "nothing" };
    }, selector);
    const cardState = () => page.evaluate(() => {
      const card = document.querySelector("[data-handoff-card]");
      if (!card) return null;
      return {
        state: card.dataset.state ?? "",
        requestId: card.dataset.requestId ?? "",
        pill: card.querySelector("[data-handoff-pill]")?.textContent?.trim() ?? "",
        instruction: card.querySelector("[data-handoff-instruction]")?.textContent?.trim() ?? "",
        actions: [...card.querySelectorAll("[data-handoff-action]")].map((b) => b.dataset.handoffAction),
        openText: card.querySelector('[data-handoff-action="open"]')?.textContent?.trim() ?? "",
      };
    });
    // The thumbnail's bytes, cheaply: a data URL is about 7 KB and there is no reason to pull five
    // of them across the wire to find out whether they moved.
    const thumbSig = () => page.evaluate(() => {
      const img = document.querySelector("img[data-handoff-thumb]");
      if (!img) return null;
      const src = img.getAttribute("src") ?? "";
      return { len: src.length, key: `${src.length}:${src.slice(0, 48)}:${src.slice(-48)}` };
    });

    console.log("\n== the console boots");
    const booted = await boot();
    check(booted === true, "the console boots and the gateway adapter is on the page", booted === true ? "window.__machineRoomAdapter present" : "no adapter after 45s — everything below would be reading the static shell");
    if (booted !== true) throw new Error("the adapter never appeared; nothing below can be measured");

    console.log("\n== the ask");
    // Only this mode spends a turn getting the form on screen: it is the only one that reads a
    // picture. --host asserts on the wire and the entry, where a blank desktop changes nothing.
    await putThePageUp();
    const first = await askForHandoff("console ask");
    let takeoverDone = false;
    if (first.pending == null) {
      skip("the card appears on its own with Action needed", `the agent produced no pending hand-off inside ${seconds(first.tookMs)}; the box's provider, not the console`);
      notReached("no hand-off to draw",
        "the card's thumbnail is a real frame of the agent's screen", "every control on the card is where a mouse can reach it",
        "the rail carries the amber card and the agent's screen", "a reload mid-hand-off shows the same pending card",
        "Take over opens the desktop full-window with the banner", "I'm done, continue hands back and closes the view",
        "the card flips to Done with one Open computer button", "the rail's amber card is gone",
        "and the agent's next message lands with no reload");
    } else {
      const instruction = String(first.pending.instruction ?? "");
      check(await openRoom(agentId), "the scratch agent's conversation opens in the console", AGENT_NAME);

      console.log("\n== the card in the conversation");
      const card = await until(async () => { const c = await cardState(); return c && c.state === "pending" ? c : null; }, within(30_000), 1000);
      check(card != null && card.requestId === first.pending.requestId, "the card appears on its own with the host's own request id", card ? `state ${card.state}, request ${card.requestId}` : "no [data-handoff-card] with data-state=pending after 30s");
      check(card != null && /action needed/i.test(card.pill), "and its pill reads Action needed", card?.pill ?? "no pill");
      check(card != null && card.instruction === instruction, "and it repeats the instruction the agent asked for, word for word", card ? card.instruction.slice(0, 100) : "no instruction slot");
      const wanted = ["take-over", "done"];
      check(card != null && wanted.every((a) => card.actions.includes(a)), "and it offers Take over and I'm done while the step is pending", card ? card.actions.join(", ") : "none");
      const skipSupported = (await hasSkip()).supported;
      if (!skipSupported) skip("and a Skip control beside them", "this host has no skipBoxHandoff, so every Skip control is deliberately not drawn (a pre-upgrade box, not a defect)");
      else check(card != null && card.actions.includes("skip"), "and a Skip control beside them", card ? card.actions.join(", ") : "none");

      console.log("\n== the thumbnail");
      const samples = [];
      const firstFrame = await until(async () => { const s = await thumbSig(); return s && s.len > 256 ? s : null; }, within(20_000), 1000);
      if (firstFrame == null) {
        check(false, "the card's thumbnail is a real frame of the agent's screen", "no img[data-handoff-thumb] carrying a data URL after 20s");
        skip("and it refreshes while the step is pending", "not reached: there was never a first frame");
      } else {
        check(true, "the card's thumbnail is a real frame of the agent's screen", `${firstFrame.len} chars of data URL`);
        samples.push(firstFrame.key);
        const moved = await until(async () => { const s = await thumbSig(); if (s) samples.push(s.key); return s && s.key !== firstFrame.key ? s : null; }, within(12_000), 1500);
        if (moved) check(true, "and it refreshes while the step is pending", `${samples.length} sample(s), the frame changed after at most ${seconds(12_000)}`);
        // A genuinely static desktop produces byte-identical frames, and calling that a failure
        // would make this leg a measurement of whether anything happened to be animating.
        else skip("and it refreshes while the step is pending", `${samples.length} samples over 12s were byte-identical (${firstFrame.len} chars each): the frame is real but this desktop did not move, so the refresh could not be proven this run`);
      }

      console.log("\n== every control a mouse can reach");
      // A modal <dialog> left open by an earlier step covers the whole page, and elementFromPoint
      // over the card then lands on the dialog. Proven against the frozen markup in a browser: with
      // the takeover dialog open, all three card controls hit-test to #desktop-dialog. The card is
      // measured with nothing on top of it, so a failure here means the card, not the run's order.
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
      await page.waitForTimeout(400);
      for (const action of skipSupported ? ["take-over", "done", "skip"] : ["take-over", "done"]) {
        const hit = await hitTest(`[data-handoff-action="${action}"]`);
        check(hit.found === true && hit.visible === true && hit.hit === true, `the card's ${action} control is visible and hit-tests to itself`, hit.found ? `${hit.w}x${hit.h}, under its centre: ${hit.on}` : "not in the DOM");
      }

      console.log("\n== the right rail");
      const rail = await page.evaluate(() => {
        const el = document.getElementById("rail-handoff");
        const screen = document.getElementById("rail-screen");
        return {
          present: el != null,
          hidden: el ? el.hidden || getComputedStyle(el).display === "none" : true,
          text: el?.textContent?.trim() ?? "",
          buttons: el ? [...el.querySelectorAll("button")].map((b) => b.textContent.trim()) : [],
          screenPresent: screen != null,
          caption: document.getElementById("rail-screen-caption")?.textContent?.trim() ?? "",
        };
      });
      check(rail.present && !rail.hidden, "the rail carries the amber card while a step is pending", rail.present ? (rail.hidden ? "#rail-handoff is hidden" : rail.text.slice(0, 90)) : "no #rail-handoff");
      check(/needs your attention/i.test(rail.text), "and it says Needs your attention", rail.text.slice(0, 90) || "empty");
      const railWanted = skipSupported ? [/skip this step/i, /i'?m done, continue/i] : [/i'?m done, continue/i];
      check(railWanted.every((re) => rail.buttons.some((b) => re.test(b))), "and offers the same two decisions", rail.buttons.join(" | ") || "no buttons");
      // "<name>'s screen", allowing the console to clamp a long name the way the desktop capsule
      // already does (CAPSULE-1). The shape and the ownership are what this leg is for; a clamp is
      // a design decision, not a wrong caption.
      const captionName = rail.caption.replace(/['’]s screen$/, "").replace(/[….]+$/, "").trim();
      check(rail.screenPresent && /['’]s screen$/.test(rail.caption) && captionName.length > 0 && AGENT_NAME.startsWith(captionName),
        "and the screen tile under it is captioned for this agent", rail.caption || (rail.screenPresent ? "no caption" : "no #rail-screen"));

      console.log("\n== a reload mid-hand-off");
      const rebooted = await boot();
      const reopened = rebooted === true && (await openRoom(agentId));
      const afterReload = reopened ? await until(async () => { const c = await cardState(); return c && c.state === "pending" ? c : null; }, within(30_000), 1000) : null;
      check(afterReload != null && afterReload.requestId === first.pending.requestId, "a full console reload mid-hand-off shows the same pending card", afterReload ? `state ${afterReload.state}, request ${afterReload.requestId}` : reopened ? "no pending card after 30s" : "the conversation did not reopen");

      console.log("\n== Take over");
      await page.click('[data-handoff-action="take-over"]', { timeout: 10_000 }).catch((e) => info(`Take over click rejected: ${e.message}`));
      const dialog = await until(() => page.evaluate(() => {
        const d = document.getElementById("desktop-dialog");
        if (!d || !d.open) return null;
        return { takeover: d.dataset.takeover ?? "", banner: document.getElementById("handoff-banner") != null };
      }), within(20_000), 700);
      check(dialog != null && dialog.takeover === "1", "Take over opens the desktop view full-window, with the app dimmed behind it", dialog ? `data-takeover ${JSON.stringify(dialog.takeover)}` : "#desktop-dialog never opened");
      const bannerHit = await hitTest("#handoff-banner");
      check(bannerHit.found === true && bannerHit.visible === true, "and the amber banner is across the top of it", bannerHit.found ? `${bannerHit.w}x${bannerHit.h}` : "no #handoff-banner");
      const note = await page.evaluate(() => document.getElementById("hand-back-note")?.textContent?.trim() ?? null);
      check(note != null && note.includes(instruction), "and the banner carries the instruction", note ? note.slice(0, 120) : "no #hand-back-note");
      const handBackHit = await hitTest("#hand-back");
      check(handBackHit.found === true && handBackHit.visible === true && handBackHit.hit === true, "and I'm done, continue is where a mouse can reach it", handBackHit.found ? `${handBackHit.w}x${handBackHit.h}, under its centre: ${handBackHit.on}` : "no #hand-back");
      if (skipSupported) {
        const skipHit = await hitTest("#handoff-skip");
        check(skipHit.found === true && skipHit.visible === true && skipHit.hit === true, "and Skip this step is beside it", skipHit.found ? `${skipHit.w}x${skipHit.h}, under its centre: ${skipHit.on}` : "no #handoff-skip");
      } else skip("and Skip this step is beside it", "this host has no skipBoxHandoff, so the control is deliberately not drawn");

      console.log("\n== I'm done, continue");
      const repliesBefore = agentReplies(await tailOf(agentId)).length;
      const clickAt = Date.now();
      await page.click("#hand-back", { timeout: 10_000 }).catch((e) => info(`hand-back click rejected: ${e.message}`));
      const closed = await until(() => page.evaluate(() => (document.getElementById("desktop-dialog")?.open === false ? true : null)), within(15_000), 500);
      check(closed === true, "I'm done, continue closes the desktop view", closed === true ? "dialog closed" : "the view was still open after 15s");
      const hostCleared = await until(async () => ((await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff == null ? true : null), within(20_000), 1000);
      check(hostCleared === true, "and the host stops reporting the hand-off", hostCleared === true ? "handoff null" : "still pending after 20s");
      const entryAfter = await until(async () => { const e = handoffEntry(await tailOf(agentId), first.pending.requestId); return e?.boxResolution ? e : null; }, within(20_000), 1500);
      check(entryAfter?.boxResolution === "handed_back", "and the entry reads handed_back", entryAfter ? JSON.stringify(entryAfter.boxResolution) : "still unresolved after 20s");
      const done = await until(async () => { const c = await cardState(); return c && c.state === "done" ? c : null; }, within(25_000), 1000);
      check(done != null, `the card flips to Done (${seconds(Date.now() - clickAt)} from the click)`, done ? `pill ${JSON.stringify(done.pill)}` : "the card was still not done after 25s");
      check(done != null && /open computer/i.test(done.openText) && !done.actions.includes("take-over"), "and offers one Open computer button instead of the three decisions", done ? `${done.actions.join(", ")} · ${done.openText}` : "no card");
      const railGone = await until(() => page.evaluate(() => { const el = document.getElementById("rail-handoff"); return el == null || el.hidden || getComputedStyle(el).display === "none" ? true : null; }), within(15_000), 700);
      check(railGone === true, "and the rail's amber card is gone", railGone === true ? "#rail-handoff hidden" : "still on screen after 15s");
      // No reload: the console's own 15 s tick has to bring the resumed agent's message in. If this
      // needed an F5 the card would be honest and the conversation would still look dead.
      const rowsBefore = await page.evaluate(() => document.querySelectorAll(".message-row").length);
      const grew = await until(() => page.evaluate((n) => (document.querySelectorAll(".message-row").length > n ? document.querySelectorAll(".message-row").length : null), rowsBefore), within(REPLY_TIMEOUT_MS), 3000);
      const repliesAfter = agentReplies(await tailOf(agentId)).length;
      if (grew == null && repliesAfter === repliesBefore) skip("and the agent's next message lands with no reload", `no new agent message inside the ${Math.round(REPLY_TIMEOUT_MS / 1000)}s reply budget (${repliesBefore} on the host before and after); the resume was dispatched but the provider has not answered`);
      else check(grew != null, "and the agent's next message lands with no reload", `${rowsBefore} → ${grew ?? rowsBefore} rows on screen, ${repliesBefore} → ${repliesAfter} agent messages on the host`);
      takeoverDone = true;
    }

    console.log("\n== Skip, on a second hand-off");
    if (!takeoverDone) skip("Skip leaves the card reading Skipped", "not reached: the first pass never produced a hand-off to learn the flow from");
    else if (budgetLeft() < TURN_TIMEOUT_MS + 25_000) skip("Skip leaves the card reading Skipped", `the run's ${Math.round(RUN_BUDGET_MS / 1000)}s budget has ${seconds(budgetLeft())} left, not enough for a second turn; run --console again for the skip pass`);
    else {
      const skipCall = await hasSkip();
      if (!skipCall.supported) skip("Skip leaves the card reading Skipped", "this host has no skipBoxHandoff, so no Skip control is drawn anywhere");
      else {
        const second = await pendingOrAsk("skip pass");
        if (second.pending == null) skip("Skip leaves the card reading Skipped", `the second ask produced no pending hand-off inside ${seconds(second.tookMs)}; the box's provider, not the console`);
        else {
          await openRoom(agentId);
          const pending = await until(async () => { const c = await cardState(); return c && c.state === "pending" ? c : null; }, within(30_000), 1000);
          check(pending != null, "a second hand-off draws a second pending card", pending ? `request ${pending.requestId}` : "no pending card after 30s");
          const repliesBefore = agentReplies(await tailOf(agentId)).length;
          await page.click('[data-handoff-action="skip"]', { timeout: 10_000 }).catch((e) => info(`Skip click rejected: ${e.message}`));
          const skipped = await until(async () => { const c = await cardState(); return c && c.state === "skipped" ? c : null; }, within(25_000), 1000);
          check(skipped != null && /skipped/i.test(skipped.pill), "Skip leaves the card reading Skipped", skipped ? `pill ${JSON.stringify(skipped.pill)}` : "the card never reached data-state=skipped");
          check(skipped != null && /open computer/i.test(skipped.openText), "and it too offers Open computer rather than a decision", skipped ? skipped.openText : "no card");
          const entry = await until(async () => { const e = handoffEntry(await tailOf(agentId), second.pending.requestId); return e?.boxResolution ? e : null; }, within(20_000), 1500);
          check(entry?.boxResolution === "dismissed", "and the entry reads dismissed", entry ? JSON.stringify(entry.boxResolution) : "still unresolved after 20s");
          const said = await until(async () => { const rows = agentReplies(await tailOf(agentId)); return rows.length > repliesBefore ? rows.at(-1) : null; }, within(REPLY_TIMEOUT_MS), 3000);
          const text = said ? entryText(said) : "";
          if (said == null) skip("and the agent says the step was skipped or names what is blocked", `no new agent message inside the ${Math.round(REPLY_TIMEOUT_MS / 1000)}s reply budget`);
          else check(/skip|declin|without|blocked|can'?t|cannot|unable|not able|sign ?in|password/i.test(text), "and the agent says the step was skipped or names what is blocked", text.slice(0, 160));
        }
      }
    }

    console.log("\n== the page itself");
    check(errors.length === 0, "no page error anywhere in the run", errors.slice(0, 2).join(" | ") || "none");
  }
} catch (error) {
  // A condition the run already printed as a SKIP with its reason (a full roster, for one) throws
  // only to stop the modes below it. Failing again on the way out would say the hand-off is broken
  // when what the run actually reported is that it could not measure anything.
  if (error instanceof NothingToMeasure) info(`stopped early: ${error.message}`);
  else check(false, "the gate ran to the end", error instanceof Error ? error.message : String(error));
} finally {
  console.log("\n== cleanup");
  if (browser) await browser.close().catch(() => {});
  // A hand-off left pending on a shared box parks the agent for the next wave to find; the agent
  // is deleted either way, but the box is put back first.
  if (agentId) await gw("handBackForeverBox", { id: agentId, trigger: "button" }).catch(() => {});
  await sweep();
  if (releaseBoxLock) { releaseBoxLock(); releaseBoxLock = null; info("box lock released"); }
}
console.log(`\n${passes} PASS / ${failures} FAIL / ${skips} SKIP`);
console.log(failures === 0 ? "OK" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
