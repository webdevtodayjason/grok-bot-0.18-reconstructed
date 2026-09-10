#!/usr/bin/env node
// verify-push.mjs -- a card that needs a person reaches the person (PUSH-1, docs/APPS.md).
//
// What this gate is for. A phone app is worth building for exactly one capability, and this is it: an
// agent parks on something only a person can answer, and the person's phone lights up once, with the
// card's own words, and the number on the app icon matches what is actually waiting. Everything else
// in the apps wave is plumbing for this.
//
// IT MEASURES THE STUB, ON PURPOSE. This wave holds no Apple key and no Firebase service account --
// those are Jason's to paste into the admin console the item also builds. So the sender is the stub,
// which records exactly what WOULD have been sent: the target, the headers and the whole payload, one
// JSON line each. Every assertion below is therefore an assertion about bytes rather than about a log
// sentence, and the day a real credential lands nothing in this file has to change except which
// sender the edge picks.
//
// THREE THINGS IT DOES NOT PRETEND ABOUT, each printed in the run rather than hidden:
//
//   1. ITEM A'S ROUTE LINE. ui/server.mjs is item A's file outright this wave, so the /push routes are
//      not mounted in the relay in this worktree. The gate therefore runs the REAL handler --
//      pushRoutes(deps), the same function with the same arguments item A wires at one call site -- on
//      a front port that passes everything else through to the live relay. The console the browser
//      loads is the real console off the real relay; the only thing standing in for item A is one
//      line of dispatch. That is said out loud in the run's first lines.
//
//   2. ITEM B'S BOOT PARSE. The https deep link lands on /?agent=&entry=, and the twelve-line parse
//      that reads those two and reveals the entry is item B's. With it absent this gate still proves
//      the link is well formed and that the console opens, and SKIPS the "the right card is revealed"
//      leg naming item B rather than banking a pass on a console that opened on its default
//      conversation.
//
//   3. A REAL PHONE. Chrome is not iOS. Nothing here claims a notification arrived on a device; what
//      is claimed is that one send was recorded, with the right collapse key, title, badge and link.
//
// TWO MODES, so each invocation fits the 300 s these gates run under, and they share the box, so they
// are run ONE AT A TIME under the box lock:
//
//   node scripts/verify-push.mjs --host     no browser: registration, a real pending hand-off, the
//                                          one send, the collapse, quiet hours, the badge, revoke,
//                                          and a sweep of every recorded byte for a secret.
//   node scripts/verify-push.mjs --console  a real browser at 390x844: the Notifications card opens
//                                          and saves, the deep link opens the console, and the
//                                          console still boots with push-settings.js absent.
//
// Both create their own scratch agent and delete it on EVERY exit path including a thrown assertion
// and a SIGTERM from the `timeout` these are run under, because Node's default signal handler ends
// the process outright and never reaches a finally.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireBoxLock } from "./lib/box-lock.mjs";
import {
  EXPIRING_CARD_TTL_MS, PUSH_CARD_KINDS, PUSH_FILE, PUSH_STUB_LEDGER_FILE, pushRoutes,
} from "../ui/push-edge.mjs";

const MODES = { host: process.argv.includes("--host"), console: process.argv.includes("--console") };
const chosen = Object.entries(MODES).filter(([, on]) => on).map(([name]) => name);
if (chosen.length !== 1) {
  console.log("usage: node scripts/verify-push.mjs (--host | --console)");
  console.log("  --host     registration, a real pending hand-off, one send, collapse, quiet hours, the badge, revoke. No browser.");
  console.log("  --console  the Notifications card, the deep link and the absent-module boot, in a real browser at 390x844.");
  process.exit(2);
}
const MODE = chosen[0];

const RELAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA_GATE = "titanbot-gate/verify-push.mjs";
// The phone the whole wave is aimed at, and the one it is measured at. Every number this gate prints
// names this viewport and this machine.
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_PUSH_BUDGET_MS ?? 270_000);
const TURN_TIMEOUT_MS = Number(process.env.GROK_BOT_TURN_TIMEOUT_MS ?? 75_000);
const CALL_TIMEOUT_MS = 30_000;

// The budget is the RUN's, and it starts when the box lock is taken rather than at import. Measured
// on grok-bot-local-vm 2026-09-10: another wave held the lock for 176 s and this gate then had 94 s
// left for a hand-off that takes 15 s to appear and a hand-back that takes up to 40 s to land. A gate
// that reports SKIP because it queued is a gate that lies about the product.
let deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(0, Math.min(ms, budgetLeft()));

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
// A leg that deliberately did not measure, with its reason. Never a pass: a gate that banks a vacuous
// PASS for a leg it never ran stops meaning the same thing twice.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const notReached = (why, ...labels) => { for (const label of labels) { console.log(`  SKIP  ${label} — not reached: ${why}`); skips += 1; } };
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const until = async (fn, ms, step = 2000) => {
  const stop = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > stop || budgetLeft() <= 0) return null;
    await sleep(step);
  }
};
class NothingToMeasure extends Error {}

// Every relay call is bounded: a gateway method that never answers would otherwise stop the whole
// gate forever with no failure and no line, and a gate that hangs is worse than one that fails.
const gw = async (method, args = {}) => {
  const response = await fetch(`${RELAY}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA_GATE },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) { const error = new Error(`${method} failed (${response.status}): ${text.slice(0, 200)}`); error.status = response.status; error.body = text; throw error; }
  return text.length > 0 ? JSON.parse(text) : null;
};

// listAgents answers a BARE ARRAY on this host and listProblemReports beside it answers an object.
// Measured on grok-bot-local-vm 2026-09-10, and it cost a gate run to find out, so it is one function
// here rather than three hopeful reads.
const rosterOf = (answer) => (Array.isArray(answer) ? answer : (Array.isArray(answer?.agents) ? answer.agents : []));

// THE GATE'S OWN COUNT OF WHAT IS WAITING, written out here rather than borrowed from the module under
// test, so "the badge matches what is actually waiting" is measured against the box and not against
// the decider's opinion of the box. It reads the same stamps the host writes in place, which is what
// makes an independent count possible at all: a card is answered when the host has stamped it, and
// every stamp is on the entry or on its message.
//
// It counts the WHOLE WORKSPACE, because that is what a badge is. This box is shared with waves D and
// V, so their pending cards are in the number too -- which is correct, and is why the legs below
// assert on this card's own collapse key rather than on a total of one.
async function pendingCardsOnTheBox(gwCall) {
  const roster = rosterOf(await gwCall("listAgents", {}).catch(() => null));
  let total = 0;
  const perAgent = [];
  for (const agent of roster) {
    const tail = await gwCall("getAgentTranscriptTail", { id: agent.id, limit: 5 }).catch(() => null);
    let here = 0;
    for (const entry of tail?.entries ?? []) {
      const message = entry?.message ?? {};
      // A hand-off: stamped on the entry, resolved by boxResolution.
      if (String(entry?.boxRequestId ?? "").length > 0 && String(entry?.boxResolution ?? "").length === 0) here += 1;
      // An approval and a local-tool ask: status on the message, and both die in ten minutes, so an
      // old one is not waiting for anybody even with no stamp on it.
      for (const [type, slot] of [["auto-review-approval", "approval"], ["local-tool-permission", "ask"]]) {
        if (message.type !== type) continue;
        const status = String(message[slot]?.status ?? "").toLowerCase();
        const fresh = Date.now() - Number(entry?.timestampMs ?? 0) < EXPIRING_CARD_TTL_MS;
        if ((status === "" || status === "pending") && fresh) here += 1;
      }
      // A widget question and a secret request: stamped on the entry.
      if (message.type === "widget" && entry?.widgetDismissed !== true && entry?.respondedValue == null) here += 1;
      if (message.type === "secret-request" && entry?.secretProvided !== true) here += 1;
    }
    if (here > 0) perAgent.push(`${String(agent.name ?? agent.id).slice(0, 24)}:${here}`);
    total += here;
  }
  const reports = await gwCall("listProblemReports", {}).catch(() => null);
  const offered = (Array.isArray(reports) ? reports : reports?.reports ?? []).length;
  return { total: total + offered, perAgent, offered, agents: roster.length };
}


// ---- the front port: the real handler, plus everything else through to the live relay -------------
//
// This is the ONE thing standing in for another item's work, and it stands in for exactly one line:
// `if (await pushRoutes(req, res, url, t)) return;` at the top of ui/server.mjs's route table. The
// handler is the real one, its dependencies are the real shapes, and every other request -- the
// console's HTML, its modules, /api, /auth/state -- is forwarded to the relay untouched, so the page
// the browser loads is the production page off the production relay.
// Which trays this run has revoked, by the id each one sends on `x-gate-tray`. It stands in for the
// relay's own fresh device-session read (ui/server.mjs's `stillLive`), and it is PER CONNECTION rather
// than a global switch, because the thing worth proving is that a revoke reaches the one connection
// whose bearer went and leaves every other tray on the same workspace alone.
const revokedTrays = new Set();

function standUpFront({ stateDir, nowRef, subRef }) {
  const t = {
    slug: "operator",
    name: "operator",
    file: (name) => path.join(stateDir, name),
    ensureDir: () => {},
    // PUSH-4. What the desktop transport opens: the tenant's own frame stream, with the tenant's own
    // headers, exactly as ui/server.mjs's relayEvents does. In production `gateway` is the box's own
    // URL out of buildContext; here it is the live relay, which is the thing in front of this box, so
    // the stream under test is reading a REAL SSE and not a fixture.
    gateway: RELAY,
    headers: (extra = {}) => ({ "user-agent": UA_GATE, ...extra }),
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => { text += String(chunk); if (text.length > 1 << 20) reject(new Error("too big")); });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
  const fail = (res, status, message) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: message }));
    return true;
  };
  const handler = pushRoutes({
    readBody, fail,
    tenants: () => [t],
    contextOf: () => t,
    // The live relay's own /api, which is where the gateway bearer lives. In production this is
    // jobBusCall, and the shape is the same: {status, text, type}. Given a timeout here for the same
    // reason the module gives its own call helper one -- an unreachable box must not hang a sweep.
    gatewayCall: async (_t, command, args) => {
      try {
        const upstream = await fetch(`${RELAY}/api/${command}`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": UA_GATE },
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        return { status: upstream.status, text: await upstream.text(), type: upstream.headers.get("content-type") ?? "application/json" };
      } catch (error) {
        return { status: 0, text: String(error?.message ?? error), type: "" };
      }
    },
    // The instance-password door has no person behind it, so it means the workspace. On a relay with
    // a control plane this is the session's `sub` claim, which is item A's.
    subOf: () => subRef.value,
    // PUSH-4's review finding, MEASURED ON THE R750 2026-09-10: a revoked bearer's stream went on
    // delivering cards, because openStream authenticated once at connect and the heartbeat kept the
    // connection alive for ever. In production this is a fresh readDeviceSession; here it is the set
    // above, asked on the same cadence.
    stillLive: (req) => !revokedTrays.has(String(req?.headers?.["x-gate-tray"] ?? "")),
    hostOf: () => "console.titanium.bot",
    now: () => nowRef.at ?? Date.now(),
    credentials: () => ({}),
    // The stub, named explicitly rather than left to SAND_PUSH_STUB, so a run cannot accidentally
    // reach a vendor because an environment variable was not set.
    stub: true,
    log: (line) => { recordedLog.push(line); },
  });

  // THE SECOND THING THE FRONT STANDS IN FOR, and it is the deploy rather than another item's code.
  // The live relay serves ui/machine-room/ out of the SHARED working copy, which does not have this
  // worktree's files: index.html without the one <script> line, and no push-settings.js at all. So the
  // three files this item adds are served from THIS worktree and every other asset, every /api call and
  // the whole session come from the live relay. That is the console as it will be after the ship, which
  // is the thing worth measuring; it is printed in the run rather than left for a reader to work out.
  const MINE = new Map([
    ["/", { file: "ui/machine-room/index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "ui/machine-room/index.html", type: "text/html; charset=utf-8" }],
    ["/push-settings.js", { file: "ui/machine-room/push-settings.js", type: "text/javascript; charset=utf-8" }],
    ["/push-settings.css", { file: "ui/machine-room/push-settings.css", type: "text/css; charset=utf-8" }],
    // SETTINGS-2, and the reason this list has to grow with the index.html above it: the front serves
    // THIS worktree's index.html and proxies every other asset to the live relay, which is the shared
    // working copy. So a <script> line added here and not added to this map is a tag pointing at a
    // 404 -- silently, because a script that does not load throws nothing. Measured on
    // grok-bot-local-vm 2026-09-10, before these three lines: the tags for settings.js and
    // account-menu.js were in the page, __mrSettings and __accountMenu were both undefined, and the
    // Notifications leg failed reading a console that had no settings surface at all.
    ["/settings.js", { file: "ui/machine-room/settings.js", type: "text/javascript; charset=utf-8" }],
    ["/settings.css", { file: "ui/machine-room/settings.css", type: "text/css; charset=utf-8" }],
    ["/account-menu.js", { file: "ui/machine-room/account-menu.js", type: "text/javascript; charset=utf-8" }],
    // app.js is this worktree's too, because openSettingsPanel and the settingsHost seam the surface
    // reads out of __mrUi are both in it. The live relay's copy has neither.
    ["/app.js", { file: "ui/machine-room/app.js", type: "text/javascript; charset=utf-8" }],
  ]);
  const here = new URL("..", import.meta.url).pathname;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (await handler(req, res, url, t)) return;

      const own = req.method === "GET" ? MINE.get(url.pathname) : null;
      if (own != null) {
        const body = readFileSync(path.join(here, own.file));
        res.writeHead(200, { "content-type": own.type, "cache-control": "no-store" });
        res.end(body);
        return;
      }

      // Through to the live relay, headers and body intact.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      const upstream = await fetch(`${RELAY}${req.url}`, {
        method: req.method,
        headers,
        ...(body && body.length > 0 ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      // A browser that navigated away aborts the socket mid-flight, and writing to it then throws
      // ERR_HTTP_HEADERS_SENT and takes the whole gate down with no summary. Measured once, on the
      // deep-link leg. So every write checks first, and a dead socket is dropped rather than thrown.
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !/^(content-encoding|transfer-encoding|connection)$/i.test(name))));
      res.end(bytes);
    } catch (error) {
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch { /* already gone */ } return; }
      try {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`the front could not reach the relay: ${String(error?.message ?? error)}`);
      } catch { /* the client is gone */ }
    }
  });
  return { t, handler, server, edge: handler.edge };
}

const recordedLog = [];
// Every frame the desktop transport wrote on this run, so the secret sweep at the end covers them the
// same way it covers a recorded send. A new surface that carries a card is a new surface that could
// carry a token, and the sweep is the leg this whole file would be worthless without.
const recordedFrames = [];

/**
 * One desktop connection to GET /push/events on the front, read as whole frames. PUSH-4: the transport
 * a desktop gets instead of a vendor, which means no APNs entitlement and no Firebase project.
 */
async function openTray(front, label, { trayId = "" } = {}) {
  const base = `http://127.0.0.1:${front.server.address().port}`;
  const controller = new AbortController();
  const at = Date.now();
  const response = await fetch(`${base}/push/events`, {
    headers: { "user-agent": UA_GATE, accept: "text/event-stream", ...(trayId.length > 0 ? { "x-gate-tray": trayId } : {}) },
    signal: controller.signal,
  });
  const frames = [];
  const comments = [];
  let headersAt = Date.now() - at;
  // Whether the SERVER ended this stream, which is what a revoke has to do and what nothing measured
  // before. `false` while the connection is held; the gate closes its own trays at the end.
  let ended = false;
  if (response.status === 200 && response.body != null) {
    void (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let held = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          held += decoder.decode(value, { stream: true });
          for (;;) {
            const cut = held.indexOf("\n\n");
            if (cut < 0) break;
            const block = held.slice(0, cut);
            held = held.slice(cut + 2);
            if (block.startsWith("data: ")) {
              const text = block.slice("data: ".length);
              recordedFrames.push(text);
              // The envelope is {channel, payload}; what every leg below asks about is the CARD, so
              // the card is what `payload` holds here and the channel is kept beside it. Reading the
              // envelope as the card is how the first run of this leg reported a row of undefineds.
              const envelope = JSON.parse(text);
              frames.push({ at: Date.now(), channel: String(envelope?.channel ?? ""), payload: envelope?.payload ?? {} });
            } else if (block.startsWith(":")) comments.push(block);
          }
        }
      } catch { /* the gate hung up, or the relay did */ }
      ended = true;
    })();
  }
  return {
    label,
    trayId,
    status: response.status,
    get ended() { return ended; },
    /** Waits for the server to end this stream, or gives up, so a leg never hangs on one that does not. */
    async waitForEnd(ms) {
      const stop = Date.now() + ms;
      while (!ended && Date.now() < stop && budgetLeft() > 0) await sleep(250);
      return ended;
    },
    headers: response.headers,
    openedAt: at,
    headersAt,
    frames,
    comments,
    /** Waits for a frame the predicate likes, and answers it with how long it took. */
    async waitFor(fn, ms) {
      const stop = Date.now() + ms;
      for (;;) {
        const found = frames.find((frame) => fn(frame.payload));
        if (found != null) return { ...found, waitedMs: found.at - at };
        if (Date.now() > stop || budgetLeft() <= 0) return null;
        await sleep(100);
      }
    },
    close() { try { controller.abort(); } catch { /* already gone */ } },
  };
}

/** Every line the stub sender wrote, newest last. */
function recordedSends(stateDir) {
  const file = path.join(stateDir, PUSH_STUB_LEDGER_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

// ---- the scratch agent ---------------------------------------------------------------------------
const AGENT_NAME = `push gate ${MODE} ${Date.now()}`;
const ASK = "I need to sign in to something on your computer myself. Hand the computer over to me "
  + "for the sign-in with a one-line instruction and wait for me. Do not try to sign in yourself.";
let agentId = null;
let sweeping = false;
const sweep = async () => {
  if (!agentId || sweeping) return;
  sweeping = true;
  const id = agentId;
  agentId = null;
  let why = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { await gw("deleteAgent", { id }); info(`scratch agent ${id} deleted${attempt > 1 ? ` (attempt ${attempt})` : ""}`); sweeping = false; return; }
    catch (error) { why = error.message; if (attempt < 3) await sleep(4000); }
  }
  console.log(`  WARN  the scratch agent ${id} could not be deleted (${why}); sweep it by hand`);
  sweeping = false;
};

async function makeScratchAgent() {
  const startedAt = Date.now();
  let created = null;
  for (;;) {
    created = await gw("createAgent", { name: AGENT_NAME, description: `verify-push ${MODE} scratch agent` }).catch((error) => ({ error: error.message }));
    if (created?.error == null || !/gateway unreachable/i.test(String(created.error))) break;
    if (Date.now() - startedAt > Math.min(60_000, budgetLeft())) break;
    info(`the host is not up (${String(created.error).slice(0, 60)}); waiting for the supervisor`);
    await sleep(5000);
  }
  const id = created?.agent?.id ?? created?.id ?? null;
  if (id == null && /holds Titan and \d+ more bots|Remove one to add another/i.test(String(created?.error ?? ""))) {
    skip("a scratch agent could be created for this run", "the box's roster is at the ONBOARD-1 cap (Titan plus twelve), so this run had nowhere to put its scratch agent. Sweep the leftover gate agents and re-run; nothing below was measured");
    throw new NothingToMeasure("the roster is at the cap");
  }
  if (id == null && /gateway unreachable/i.test(String(created?.error ?? ""))) {
    skip("a scratch agent could be created for this run", `the box's host did not answer for ${seconds(Date.now() - startedAt)}; nothing below was measured`);
    throw new NothingToMeasure("the host is not up");
  }
  check(id != null, "a scratch agent could be created for this run", id ?? JSON.stringify(created).slice(0, 160));
  if (id == null) throw new NothingToMeasure("no scratch agent");
  agentId = id;
  return id;
}

// ---- the run -------------------------------------------------------------------------------------

let release = () => {};
let front = null;
let browser = null;
const stateDir = mkdtempSync(path.join(tmpdir(), `push-gate-${MODE}-`));
const nowRef = { at: null };
const subRef = { value: "" };

const shutdown = async () => {
  await sweep();
  try { await browser?.close(); } catch { /* already gone */ }
  try { front?.edge?.close?.(); } catch { /* already gone */ }
  await new Promise((resolve) => { if (front?.server) front.server.close(resolve); else resolve(); });
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* already gone */ }
  release();
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdown().then(() => process.exit(130)); });
}

try {
  // Up to 120 minutes of waiting, because waves D and V share this box and queueing behind one of
  // them is normal. The run's own budget starts on the line after.
  release = await acquireBoxLock({ what: `verify-push ${MODE}`, waitMs: 120 * 60_000, log: (line) => info(line) });
  deadline = Date.now() + RUN_BUDGET_MS;

  console.log(`\nverify-push --${MODE} · grok-bot-local-vm on this Mac · relay ${RELAY} · ${MODE === "console" ? `${PHONE.width}x${PHONE.height}, scale ${PHONE.deviceScaleFactor}, touch, iPhone UA` : "no browser"} · budget ${Math.round(RUN_BUDGET_MS / 1000)}s`);
  info("the sender is the STUB: this wave holds no Apple key and no Firebase service account, so every assertion below is on the bytes that would have gone out");
  info("the /push routes run through pushRoutes(deps) -- the real handler item A wires at one call site -- on a front port that passes every other request to the live relay, so the session, /api and every other asset are the production ones");
  info("the front also serves this worktree's index.html, push-settings.js and push-settings.css, because the live relay serves ui/machine-room/ out of the shared working copy, which has neither. Everything else on the page comes off the relay");

  front = standUpFront({ stateDir, nowRef, subRef });
  await new Promise((resolve) => front.server.listen(0, "127.0.0.1", resolve));
  const FRONT = `http://127.0.0.1:${front.server.address().port}`;
  info(`front ${FRONT} · push state ${stateDir}`);

  const ask = async (method, pathname, body) => {
    const response = await fetch(`${FRONT}${pathname}`, {
      method,
      headers: { "user-agent": UA_GATE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, text };
  };

  /** The same request with the body untouched, for the bodies JSON.parse has to refuse. */
  const askRaw = async (method, pathname, raw) => {
    const response = await fetch(`${FRONT}${pathname}`, {
      method,
      headers: { "user-agent": UA_GATE, "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, text };
  };

  // ---- the door the app comes through ----------------------------------------------------------
  //
  // Item A's POST /auth/token mints the device bearer an app holds. If it is live on this relay the
  // gate uses it, because that is the real path; if it is not, the registration goes through the
  // console's own door, which is the other half of the same contract ("behind the device bearer, or
  // the cookie for the console's own settings page"), and the run says which it used.
  let bearer = "";
  const door = await fetch(`${RELAY}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA_GATE },
    body: JSON.stringify({ deviceId: `push-gate-${MODE}`, name: `verify-push ${MODE}` }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch(() => null);
  if (door != null && door.status === 200) {
    const minted = await door.json().catch(() => null);
    bearer = String(minted?.token ?? "");
  }
  if (bearer.length > 0) check(true, "a device bearer was minted through item A's door", "POST /auth/token answered 200");
  else skip("a device bearer was minted through item A's door", `this relay has no /auth/token yet (it answered ${door == null ? "nothing" : door.status}), so registration below goes through the console's own door, which is the other half of the same contract`);

  if (MODE === "host") {
    // ===========================================================================================
    // --host: registration, a real pending hand-off, the one send, collapse, quiet hours, revoke.
    // ===========================================================================================

    // PUSH-4's connection, opened once the card exists and held across the hand-back, and closed on
    // every exit path including a thrown assertion. Declared here because the secret sweep at the end
    // reads its frames whether or not a card ever appeared.
    let tray = null;

    console.log("\n== registration");
    const registered = await ask("POST", "/push/devices", { platform: "ios", token: "gate-device-token-0123456789abcdef", deviceId: "gate-phone-1", name: "the gate's iPhone" });
    check(registered.status === 200 && registered.body?.deviceId === "gate-phone-1", "a device registers behind the door", `HTTP ${registered.status} ${JSON.stringify(registered.body).slice(0, 120)}`);
    check(!registered.text.includes("gate-device-token"), "and the answer never carries the token back", "no token in the response body");
    const again = await ask("POST", "/push/devices", { platform: "ios", token: "a-refreshed-token", deviceId: "gate-phone-1" });
    check(again.body?.replaced === true, "a second registration of the same device updates rather than duplicating", `replaced ${again.body?.replaced}`);
    const listed = await ask("GET", "/push/devices");
    check(listed.body?.devices?.length === 1, "one device is on the list", `${listed.body?.devices?.length} device(s)`);
    check(!Object.hasOwn(listed.body?.devices?.[0] ?? {}, "token"), "and the list never carries a token", "deviceId, platform, name, env and timestamps only");

    // =============================================================================================
    // PUSH-4. A DESKTOP COSTS ITS WORKSPACE NOTHING UNTIL SOMEBODY IS LISTENING.
    //
    // This is the claim that makes registering a desktop safe, and it is the reason the desktop app
    // left registration switched off: before this, a registered device of any kind armed the 15 s
    // sweep for that workspace, and a desktop row holds a device id where an APNs token belongs, so
    // every card was refused with BadDeviceToken -- which deliberately does not prune -- burned six
    // attempts and gave up with the row still on disk.
    //
    // A WORKSPACE OF ITS OWN, because the main one already has a phone on it and a phone is a reason
    // to look. This is the only honest way to measure "a desktop alone".
    // =============================================================================================
    console.log("\n== the desktop transport, with no vendor anywhere in it");
    const deskDir = mkdtempSync(path.join(tmpdir(), "push-gate-desk-"));
    const desk = standUpFront({ stateDir: deskDir, nowRef, subRef: { value: "" } });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    const deskAsk = async (method, pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${desk.server.address().port}${pathname}`, {
        method,
        headers: { "user-agent": UA_GATE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed, text };
    };
    try {
      const deskRow = await deskAsk("POST", "/push/devices", { platform: "desktop", token: "mac-hardware-id-not-an-apns-token", deviceId: "gate-mac-1", name: "the gate's Mac" });
      check(deskRow.status === 200 && deskRow.body?.platform === "desktop", "a desktop registers", `HTTP ${deskRow.status} ${JSON.stringify(deskRow.body).slice(0, 110)}`);

      const callsBefore = desk.edge.stats().gatewayCalls;
      const quietPass = await desk.edge.sweepOnce("a desktop and nobody listening");
      const quietCalls = desk.edge.stats().gatewayCalls - callsBefore;
      check(quietCalls === 0 && quietPass.swept?.[0]?.calls === 0,
        "and a pass with nobody listening reaches the box ZERO times",
        `${quietCalls} gateway call(s), the pass said "${String(quietPass.swept?.[0]?.skipped ?? "")}"`);
      check(quietPass.swept?.[0]?.devices === 1 && quietPass.swept?.[0]?.carried === 1 && quietPass.swept?.[0]?.listening === 0,
        "with the row on disk all the same, so it is registration and not a refusal",
        `devices ${quietPass.swept?.[0]?.devices}, carried by the stream ${quietPass.swept?.[0]?.carried}, listening ${quietPass.swept?.[0]?.listening}`);
      check(recordedSends(deskDir).length === 0, "and no vendor was asked about it at all", "nothing recorded by the stub sender");

      // And with a tray connected the pass runs, because a card a tray has to hear about is what it
      // is for. Measured against the live box: this is 1 + 1 + N calls, the same as a phone's pass.
      const tray = await openTray(desk, "the arming tray");
      try {
        check(tray.status === 200, "a tray opens GET /push/events", `HTTP ${tray.status}`);
        check(tray.headers.get("content-type") === "text/event-stream"
          && tray.headers.get("cache-control") === "no-cache"
          && tray.headers.get("x-accel-buffering") === "no",
          "with the header set relayEvents already proves through Cloudflare",
          `${tray.headers.get("content-type")}, ${tray.headers.get("cache-control")}, x-accel-buffering ${tray.headers.get("x-accel-buffering")}`);
        const armedBefore = desk.edge.stats().gatewayCalls;
        const armed = await desk.edge.sweepOnce("a desktop with a tray connected");
        check(armed.swept?.[0]?.skipped === undefined && armed.swept?.[0]?.listening === 1,
          "and a connected tray is what arms the pass", `listening ${armed.swept?.[0]?.listening}, ${desk.edge.stats().gatewayCalls - armedBefore} gateway call(s) this pass`);
        check(recordedSends(deskDir).length === 0, "and still nothing goes to a vendor", "the desktop reaches no APNs and no Firebase");
      } finally { tray.close(); }

      // The tray gone, the workspace goes quiet again. This is the half that makes the claim a rule
      // rather than a first-pass accident.
      await sleep(250);
      const after = await desk.edge.sweepOnce("the tray gone");
      check(after.swept?.[0]?.skipped === "only a desktop is registered and none is listening" && after.swept?.[0]?.calls === 0,
        "and with the tray gone the workspace reaches its box zero times again",
        `"${String(after.swept?.[0]?.skipped ?? "")}", ${after.swept?.[0]?.calls} call(s)`);
    } finally {
      desk.edge.close();
      await new Promise((resolve) => desk.server.close(resolve));
      rmSync(deskDir, { recursive: true, force: true });
    }

    console.log("\n== a real pending hand-off on the local box");
    await makeScratchAgent();
    const askedAt = Date.now();
    await gw("sendPrompt", { agentId, prompt: ASK }).catch((error) => info(`sendPrompt rejected (${error.message})`));
    const handoff = await until(async () => (await gw("getForeverBoxStatus", { id: agentId }).catch(() => null))?.handoff ?? null, within(TURN_TIMEOUT_MS), 2500);
    if (handoff == null) {
      skip("a real pending hand-off appears on the box", `the agent produced none inside ${seconds(within(TURN_TIMEOUT_MS))} (that is the box's provider, not the push path)`);
      notReached("no card to push",
        "exactly one send is recorded for one pending card",
        "and it carries the card's own title",
        "and the collapse key is this card's own",
        "and the badge equals the gate's own count of pending cards read from the box",
        "the same card a second time sends nothing",
        "quiet hours hold the alert",
        "and release exactly one catch-up on the same key",
        "answering the card drops the badge through a silent send",
        "GET /push/pending answers this card, with the relay's own title and sentence",
        "and its badge equals the gate's own count of pending cards read from the box",
        "and a second read inside the memo window costs no gateway call",
        "a tray gets this card on connect",
        "on the channel the console's own adapter already reads",
        "and the tray's row is the row the route answers",
        "and the hand-back arrives as a closed frame on the same key");
    } else {
      check(true, "a real pending hand-off appears on the box", `${seconds(Date.now() - askedAt)} from prompt to pending, requestId ${String(handoff.requestId).slice(0, 12)}`);

      // The gate's OWN count of what is waiting across the whole workspace, read straight from the box
      // rather than from the thing under test. It is the number the badge has to match, and it is the
      // workspace's and not this agent's, because that is what a badge on a home screen means.
      //
      // THIS BOX IS SHARED with waves D and V, so their pending cards are in the number too. That is
      // correct, and it is why every leg below asserts on THIS card's own collapse key rather than on a
      // total of one: a gate that demanded a total of one would be a gate that only passes on an idle
      // box, which is a gate that passes for the wrong reason.
      const waiting = await pendingCardsOnTheBox(gw);
      info(`the gate counts ${waiting.total} pending card(s) across ${waiting.agents} agent(s) on this box, read straight from the box${waiting.perAgent.length > 0 ? ` (${waiting.perAgent.join(", ")}${waiting.offered > 0 ? `, ${waiting.offered} report offer(s)` : ""})` : ""}`);

      console.log("\n== one card, one push");
      // Swept until the card lands, not once. Measured on grok-bot-local-vm 2026-09-10: this box's
      // host restarts under the other waves' gates, and listAgents answers an EMPTY roster for a few
      // seconds after each restart (countAgents went 11, 11, unreachable, unreachable, 10 over two
      // minutes). A single pass landing in that window would report FAIL about the box blinking, which
      // is the kind of green-or-red-for-the-wrong-reason this whole gate exists to avoid. The sweep is
      // idempotent by construction -- the ledger is on disk -- so sweeping more than once cannot
      // manufacture a send, which is what makes the retry safe rather than a way to pass.
      let lastSweep = null;
      let passCount = 0;
      const mine = (rows) => rows.filter((row) => row.kind === "box-handoff" && String(row.payload?.agent ?? "") === agentId);
      const sends = await until(async () => {
        lastSweep = await front.edge.sweepOnce(`the gate's pass ${passCount += 1}`);
        const rows = mine(recordedSends(stateDir));
        return rows.length > 0 ? rows : null;
      }, within(60_000), 4000) ?? [];
      if (sends.length === 0) {
        const roster = await gw("listAgents", {}).catch(() => null);
        const onRoster = rosterOf(roster).some((agent) => agent.id === agentId);
        info(`${passCount} sweep pass(es) recorded nothing for this agent; it was ${onRoster ? "" : "NOT "}on the roster at the last read (${rosterOf(roster).length} agent(s)), sweep said ${JSON.stringify(lastSweep?.swept?.[0] ?? null)}`);
      }
      check(sends.length === 1, "exactly one send is recorded for this pending card", `${sends.length} for this agent out of ${recordedSends(stateDir).length} on the box, after ${passCount} pass(es)`);
      const sent = sends[0] ?? {};
      const title = `Take the keyboard for ${AGENT_NAME}`;
      check(sent.payload?.aps?.alert?.title === title, "and it carries the card's own title", JSON.stringify(sent.payload?.aps?.alert ?? null).slice(0, 160));
      check(String(sent.payload?.aps?.alert?.body ?? "").length > 0 && String(sent.payload.aps.alert.body).length <= 140, "and a reason clipped to the host's own 140 characters", `${String(sent.payload?.aps?.alert?.body ?? "").length} characters`);
      check(/^[0-9a-f]{32}$/.test(String(sent.headers?.["apns-collapse-id"] ?? "")) && sent.headers["apns-collapse-id"] === sent.cardKey,
        "and the collapse key is this card's own", String(sent.headers?.["apns-collapse-id"] ?? "absent"));
      check(sent.headers?.["apns-push-type"] === "alert" && sent.headers?.["apns-priority"] === "10", "and it goes out as a priority alert", `${sent.headers?.["apns-push-type"]} at priority ${sent.headers?.["apns-priority"]}`);
      // One badge number, and the gate's own count is what it is compared against. They are read a few
      // seconds apart on a live shared box, so a one-card drift is the box moving rather than the badge
      // being wrong; anything wider is the badge being wrong and is a FAIL with both numbers printed.
      const drift = Math.abs(Number(sent.badge) - waiting.total);
      check(Number.isFinite(Number(sent.badge)) && sent.payload?.aps?.badge === sent.badge && drift <= 1,
        "and the badge equals the gate's own count of pending cards read from the box",
        `badge ${sent.badge}, the gate counted ${waiting.total} across the workspace${drift === 0 ? "" : ` (${drift} apart; the two reads are seconds apart on a box three waves share)`}`);

      check(String(sent.payload?.link ?? "").startsWith("titaniumbot://card?") && String(sent.payload?.web ?? "").startsWith("https://"),
        "and both deep links are on the payload, beside aps and never inside it", `${String(sent.payload?.link ?? "").slice(0, 64)} / ${String(sent.payload?.web ?? "").slice(0, 64)}`);
      check(Buffer.byteLength(JSON.stringify(sent.payload ?? {}), "utf8") < 4096, "and the whole payload fits a notification", `${Buffer.byteLength(JSON.stringify(sent.payload ?? {}), "utf8")} bytes of 4096`);

      // THE CONSOLE'S OWN NUMBER, printed beside the badge. It counts AGENTS, at most one per agent,
      // and misses two of the six kinds, so the two disagree the moment one agent holds two cards.
      // PUSH-3 is the filed row; this line is why it is filed.
      const consoleNeedsYou = rosterOf(await gw("listAgents", {}).catch(() => null)).filter((agent) => agent.awaitingUserResponse != null).length;
      info(`the app badge says ${sent.badge} (cards) and the console's needs-you count says ${consoleNeedsYou} (agents, at most one each, two kinds missing) — ${sent.badge === consoleNeedsYou ? "they agree here and will not once an agent holds two cards" : "they already disagree on this box"}. Filed as PUSH-3`);

      // =========================================================================================
      // PUSH-5. WHAT IS PENDING, ANSWERED BY A ROUTE INSTEAD OF DECIDED AGAIN IN EVERY SHELL.
      //
      // Compared against the gate's OWN count, read straight from the box a moment earlier -- the
      // same independent number the badge is compared against above. That is the whole point: if
      // this route agreed with the badge but both were wrong, neither leg would notice.
      // =========================================================================================
      console.log("\n== what is pending, from the relay's own decider");
      const pendingBefore = front.edge.stats().gatewayCalls;
      const pending = await ask("GET", "/push/pending");
      const pendingCost = front.edge.stats().gatewayCalls - pendingBefore;
      const mineOnRoute = (pending.body?.cards ?? []).filter((card) => card.agent?.id === agentId && card.kind === "box-handoff");
      check(pending.status === 200 && mineOnRoute.length === 1
        && mineOnRoute[0].key === sent.cardKey
        && mineOnRoute[0].title === title
        && mineOnRoute[0].body === "Open it to read what it needs done."
        && mineOnRoute[0].pending === true,
        "GET /push/pending answers this card, with the relay's own title and sentence",
        `HTTP ${pending.status}, ${mineOnRoute.length} row(s) for this agent, key ${String(mineOnRoute[0]?.key ?? "absent")}${mineOnRoute[0]?.key === sent.cardKey ? " — the same key the push used" : ""}`);
      const routeDrift = Math.abs(Number(pending.body?.badge) - waiting.total);
      check(Number.isFinite(Number(pending.body?.badge)) && routeDrift <= 1,
        "and its badge equals the gate's own count of pending cards read from the box",
        `the route says ${pending.body?.badge} over ${pending.body?.agents} agent(s), the gate counted ${waiting.total}${routeDrift === 0 ? "" : ` (${routeDrift} apart; seconds apart on a box three waves share)`}`);
      info(`one full collection cost ${pendingCost} gateway call(s) over ${pending.body?.agents} agent(s) and ${Buffer.byteLength(pending.text, "utf8")} bytes of answer, on grok-bot-local-vm`);
      // THE MEMO IS THE WHOLE DIFFERENCE between this route and the polling it replaces. Without it a
      // desktop polling once a second pays 1 + 1 + N calls a second.
      const memoBefore = front.edge.stats().gatewayCalls;
      const again2 = await ask("GET", "/push/pending");
      check(front.edge.stats().gatewayCalls === memoBefore && again2.body?.at === pending.body?.at,
        "and a second read inside the memo window costs no gateway call",
        `${front.edge.stats().gatewayCalls - memoBefore} call(s), the same picture ${again2.body?.ageMs} ms old`);
      // Nothing a model wrote on the wire, on this new surface as on the old one.
      check(!pending.text.includes("Sign in") && !/boxInstruction|instruction/.test(pending.text),
        "and no field a model wrote rides the answer",
        `${Buffer.byteLength(pending.text, "utf8")} bytes, six fixed sentences and ids`);

      // =========================================================================================
      // PUSH-4. THE SAME CARD, ON A TRAY, WITH NO VENDOR ANYWHERE IN IT.
      //
      // Opened HERE and held across the hand-back below, because the thing worth measuring is a
      // card closing under a connection that was already open, which is what a tray actually does.
      // =========================================================================================
      console.log("\n== the desktop tray sees the same card");
      tray = await openTray(front, "the card tray");
      const onConnect = await tray.waitFor((card) => card.key === sent.cardKey && card.state === "pending", within(15_000));
      check(onConnect != null, "a tray gets this card on connect", onConnect == null
        ? "nothing inside 15s"
        : `${onConnect.waitedMs} ms from the connection opening, ${tray.frames.length} frame(s) in all`);
      const trayRow = onConnect?.payload ?? {};
      check(onConnect?.channel === "push-card", "on the channel the console's own adapter already reads", String(onConnect?.channel ?? "absent"));
      check(trayRow.title === title
        && trayRow.body === "Open it to read what it needs done."
        && trayRow.agent?.id === agentId
        && trayRow.entry === mineOnRoute[0]?.entry
        && String(trayRow.link?.app ?? "").startsWith("titaniumbot://card?"),
        "and the tray's row is the row the route answers",
        `${trayRow.kind} · "${String(trayRow.title ?? "").slice(0, 40)}" · badge ${trayRow.badge} · entry ${String(trayRow.entry ?? "").slice(0, 12)}`);

      console.log("\n== the same card, again");
      const beforeSecond = recordedSends(stateDir).length;
      await front.edge.sweepOnce("the gate's second pass");
      const afterSecond = recordedSends(stateDir);
      check(mine(afterSecond).length === 1, "the same card a second time sends nothing", `still ${mine(afterSecond).length} for this agent`);
      info(`${afterSecond.length - beforeSecond} send(s) on the second pass in total, which is whatever the other waves' agents did between the two passes`);

      console.log("\n== quiet hours");
      // A fresh workspace state, so the held card is a NEW card as far as the ledger is concerned.
      // The clock is moved by hand: a gate that waited for 23:00 would be a gate that runs once a day.
      const quietDir = mkdtempSync(path.join(tmpdir(), "push-gate-quiet-"));
      const quiet = standUpFront({ stateDir: quietDir, nowRef: { at: Date.UTC(2026, 8, 10, 23, 0, 0) }, subRef: { value: "" } });
      try {
        await quiet.edge.storeFor(quiet.t).register({ deviceId: "gate-phone-1", platform: "ios", token: "gate-token", sub: "" });
        await quiet.edge.storeFor(quiet.t).saveSettings("", { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: 0 });
        // The same live hand-off, read through a second edge pointed at the same box. Swept until the
        // card is seen, for the blinking-roster reason above; what is asserted is that nothing was
        // recorded and that the pass counted a hold.
        let held = null;
        await until(async () => {
          held = await quiet.edge.sweepOnce("inside the window");
          return Number(held?.swept?.[0]?.held) > 0 ? held : null;
        }, within(40_000), 4000);
        check(recordedSends(quietDir).length === 0 && Number(held?.swept?.[0]?.held) > 0, "quiet hours hold the alert", `nothing recorded at all, ${held?.swept?.[0]?.held} card(s) held on this box`);

        // The window ends. One catch-up, on the same collapse key, and one only.
        const after = standUpFront({ stateDir: quietDir, nowRef: { at: Date.UTC(2026, 8, 11, 7, 30, 0) }, subRef: { value: "" } });
        try {
          let out = null;
          const catchUp = await until(async () => {
            out = await after.edge.sweepOnce("the window ended");
            const rows = mine(recordedSends(quietDir));
            return rows.length > 0 ? rows : null;
          }, within(40_000), 4000) ?? [];
          check(catchUp.length === 1 && catchUp[0].silent === false && catchUp[0].cardKey === sent.cardKey,
            "and release exactly one catch-up on the same key", `${catchUp.length} for this card, key ${String(catchUp[0]?.cardKey ?? "absent")}${catchUp[0]?.cardKey === sent.cardKey ? ", the same one the first alert used" : ""}`);
          await after.edge.sweepOnce("and again");
          check(mine(recordedSends(quietDir)).length === 1, "and one only, not one a pass", `${mine(recordedSends(quietDir)).length} for this card after a second pass`);
        } finally { after.edge.close(); await new Promise((resolve) => after.server.close(resolve)); }
      } finally {
        quiet.edge.close();
        await new Promise((resolve) => quiet.server.close(resolve));
        rmSync(quietDir, { recursive: true, force: true });
      }

      // =========================================================================================
      // THE REVIEW PASS'S BLOCKER, MEASURED. A bearer revoked while its stream is open kept getting
      // every pending card in the workspace -- title, agent, entry id and deep link -- for as long as
      // it held the connection, which the 25 s heartbeat kept alive indefinitely. Revoke is the
      // lost-laptop control. A SECOND tray is opened for this, and the one already open is left alone,
      // because a revoke that took down every tray on the workspace would pass this leg and be wrong.
      // =========================================================================================
      console.log("\n== a revoked bearer loses the stream it is already holding");
      const doomed = await openTray(front, "the revoked tray", { trayId: "gate-doomed-tray" });
      check(doomed.status === 200, "a second tray opens on the same workspace", `HTTP ${doomed.status}`);
      await doomed.waitFor((card) => card.state === "pending", within(15_000));
      const framesBeforeRevoke = doomed.frames.length;
      const streamsBeforeRevoke = front.edge.streamsFor(front.t);
      info(`the doomed tray held ${framesBeforeRevoke} frame(s) before the revoke, with ${streamsBeforeRevoke} stream(s) open on this workspace`);
      revokedTrays.add("gate-doomed-tray");
      // Long enough for the slow refresh (15 s) and the heartbeat (25 s), which are the two things
      // that run on a connection nobody is talking to.
      const gone = await doomed.waitForEnd(within(45_000));
      check(gone, "the relay ends a stream whose bearer was revoked", gone
        ? `the connection closed ${seconds(Date.now() - doomed.openedAt)} after it opened, ${doomed.comments.length} comment(s) on it (${doomed.comments.map((one) => one.trim()).join(" ")})`
        : `still open after ${seconds(within(45_000))}, which is the defect the R750 measured`);
      check(doomed.frames.length === framesBeforeRevoke, "and no card rode it after the revoke",
        `${doomed.frames.length - framesBeforeRevoke} frame(s) arrived after the bearer went`);
      const streamsAfterRevoke = front.edge.streamsFor(front.t);
      check(streamsAfterRevoke === streamsBeforeRevoke - 1 && streamsAfterRevoke >= 1,
        "the revoked connection stops arming the sweep, and the tray beside it does not",
        `${streamsBeforeRevoke} stream(s) before, ${streamsAfterRevoke} after`);
      check(tray != null && !tray.ended, "and the tray that was not revoked is still open", tray == null ? "no tray" : tray.ended ? "IT CLOSED TOO" : `${tray.frames.length} frame(s) on it`);
      doomed.close();

      // =========================================================================================
      // THE OTHER REVIEW FINDING: the stream honoured neither switch the settings route exists to
      // hold -- it sent a frame for every card whatever the per-kind switch said and never consulted
      // quiet hours at all, while the vendor path refuses a muted kind and holds a quiet one. The
      // decision this wave took is that the tray is the surface that stays silent, so the WIRE says
      // which switch is in force rather than the shell re-implementing the window.
      // =========================================================================================
      console.log("\n== what a quiet window says on the wire");
      const hourNow = new Date().getUTCHours();
      await front.edge.storeFor(front.t).saveSettings(subRef.value, { quietHours: { on: true, from: hourNow, to: (hourNow + 1) % 24 }, utcOffsetMinutes: 0 });
      try {
        const inWindow = await ask("GET", "/push/pending");
        const quietRow = (inWindow.body?.cards ?? []).find((card) => card.key === sent.cardKey) ?? (inWindow.body?.cards ?? [])[0] ?? {};
        check(quietRow.quiet === true && Number(quietRow.quietUntil) > Date.now(),
          "a row inside a quiet window says so, and says when the window ends",
          `quiet ${quietRow.quiet}, quietUntil ${Number(quietRow.quietUntil) > 0 ? new Date(Number(quietRow.quietUntil)).toISOString() : "0"} (the window is ${hourNow}:00 to ${(hourNow + 1) % 24}:00 UTC)`);
        check((inWindow.body?.cards ?? []).length > 0 && Number(inWindow.body?.badge) > 0,
          "and every pending card is still on the wire, because this is the list and not the alert",
          `${(inWindow.body?.cards ?? []).length} card(s), badge ${inWindow.body?.badge}`);
        const quietTray = await openTray(front, "the quiet tray", { trayId: "gate-quiet-tray" });
        try {
          const quietFrame = await quietTray.waitFor((card) => card.state === "pending", within(15_000));
          check(quietFrame != null && quietFrame.payload?.quiet === true && Number(quietFrame.payload?.quietUntil) === Number(quietRow.quietUntil),
            "and the tray's frame carries the same two fields the route answers",
            quietFrame == null ? "no frame inside 15s" : `quiet ${quietFrame.payload?.quiet}, quietUntil ${quietFrame.payload?.quietUntil === quietRow.quietUntil ? "the same value the route gave" : String(quietFrame.payload?.quietUntil)}`);
        } finally { quietTray.close(); }
        // And the refusal the wire grew: a window that starts and ends at the same hour holds nothing.
        const zeroWidth = await ask("PUT", "/push/settings", { quietHours: { on: true, from: 9, to: 9 } });
        check(zeroWidth.status === 400 && zeroWidth.body?.error === "bad_request" && zeroWidth.body?.field === "quietHours.to",
          "a quiet window that starts and ends at the same hour is refused rather than stored",
          `HTTP ${zeroWidth.status} ${String(zeroWidth.body?.error ?? "")} field ${String(zeroWidth.body?.field ?? "absent")}`);
        const notJson = await askRaw("PUT", "/push/settings", "{not json");
        check(notJson.status === 400 && notJson.body?.error === "bad_request" && notJson.body?.field === "body",
          "and a body that is not JSON at all is refused in the same shape as every other refusal",
          `HTTP ${notJson.status} ${String(notJson.body?.error ?? "")} field ${String(notJson.body?.field ?? "absent")}`);
      } finally {
        await front.edge.storeFor(front.t).saveSettings(subRef.value, { quietHours: { on: false } });
      }

      console.log("\n== answering it");
      // handBackForeverBox is the host's own name for "the person did the step" (HANDBACK-1). Skip is
      // a separate command on purpose, because the trigger form would stamp the entry as a hand-back
      // and the card would read Done on a step nobody did.
      const handedBack = await gw("handBackForeverBox", { id: agentId, trigger: "button" }).catch((error) => ({ error: error.message }));
      if (handedBack?.error != null) {
        skip("answering the card drops the badge through a silent send", `this host has no hand-back command the gate could call (${String(handedBack.error).slice(0, 90)})`);
      } else {
        // The SILENT update for THIS card, found by its own collapse key rather than by being the last
        // row in the file: on a shared box another wave's card can land between the two.
        const closed = await until(async () => {
          await front.edge.sweepOnce("after the hand-back");
          return recordedSends(stateDir).find((row) => row.cardKey === sent.cardKey && row.silent === true) ?? null;
        }, within(40_000), 3000);
        if (closed == null) skip("answering the card drops the badge through a silent send", "the hand-back did not reach the transcript inside 40s");
        else {
          check(closed.payload?.aps?.["content-available"] === 1 && closed.payload?.aps?.alert == null && closed.payload?.aps?.sound == null,
            "answering the card drops the badge through a silent send", `badge ${closed.badge}, content-available 1, no alert and no sound`);
          check(closed.headers?.["apns-collapse-id"] === sent.headers?.["apns-collapse-id"], "and on the same collapse key, so it lands on the notification it closes", String(closed.headers?.["apns-collapse-id"] ?? "absent"));
          check(Number(closed.badge) < Number(sent.badge), "and the number on the icon went down", `${sent.badge} before, ${closed.badge} after`);
          check(mine(recordedSends(stateDir)).filter((row) => row.silent === false).length === 1, "and no second alert went out for a card that is done", `${mine(recordedSends(stateDir)).filter((row) => row.silent === false).length} alert(s) for this card in the whole run`);
        }
      }

      // PUSH-4's other half: the tray that was open before the hand-back has to see the card go. A
      // `closed` frame on the SAME key is what takes the notification down rather than drawing a
      // second one about it.
      if (tray != null) {
        const closedFrame = await tray.waitFor((card) => card.key === sent.cardKey && card.state === "closed", within(45_000));
        check(closedFrame != null, "and the hand-back arrives as a closed frame on the same key", closedFrame == null
          ? `nothing inside ${seconds(within(45_000))} (${tray.frames.length} frame(s) on this connection in all)`
          : `${Math.round((closedFrame.at - (onConnect?.at ?? tray.openedAt)) / 100) / 10}s after the pending one, badge ${closedFrame.payload?.badge}, key ${String(closedFrame.payload?.key ?? "").slice(0, 12)}…`);
        info(`the tray held ${tray.frames.length} frame(s) and ${tray.comments.length} heartbeat comment(s) over ${seconds(Date.now() - tray.openedAt)}`);
      }
    }

    console.log("\n== revoking the device");
    const removed = await ask("DELETE", "/push/devices/gate-phone-1");
    check(removed.body?.removed === true, "a device can be revoked", `removed ${removed.body?.removed}`);
    const onDisk = existsSync(path.join(stateDir, PUSH_FILE)) ? JSON.parse(readFileSync(path.join(stateDir, PUSH_FILE), "utf8")) : { devices: [] };
    check((onDisk.devices ?? []).length === 0, "and its row is gone from the workspace's own file", `${(onDisk.devices ?? []).length} device(s) left in ${PUSH_FILE}`);
    const sendsBefore = recordedSends(stateDir).length;
    const empty = await front.edge.sweepOnce("after the revoke");
    check(recordedSends(stateDir).length === sendsBefore, "and a revoked device gets no send", `still ${recordedSends(stateDir).length} recorded`);
    check(empty.swept?.[0]?.skipped === "no device is registered", "and a workspace with no device reaches its box zero times", String(empty.swept?.[0]?.skipped ?? ""));

    console.log("\n== what was written down");
    // THE LEG THIS WHOLE FILE WOULD BE WORTHLESS WITHOUT. Every recorded byte and every log line,
    // swept for a credential and for transcript prose past the clipped reason.
    // AND EVERY TRAY FRAME IS SWEPT THE SAME WAY. PUSH-4 added a surface that carries a card, so it
    // added a surface that could carry a token, and a new wire nobody sweeps is how the first one
    // came to carry a live `Authorization: Bearer sk_live_…` on its way to a lock screen.
    if (tray != null) tray.close();
    const ledgerFile = path.join(stateDir, PUSH_STUB_LEDGER_FILE);
    const everything = `${existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : ""}\n${recordedLog.join("\n")}\n${recordedFrames.join("\n")}`;
    info(`${recordedFrames.length} tray frame(s) are in the sweep below, beside every recorded send and every log line`);
    const leaks = [
      ["a whole device token", /gate-device-token-0123456789abcdef|a-refreshed-token|mac-hardware-id-not-an-apns-token/],
      ["a private key", /BEGIN (EC |RSA )?PRIVATE KEY/],
      ["a bearer", /eyJ[A-Za-z0-9_-]{10,}/],
      ["a gateway token", /SAND_HOST_GATEWAY_TOKEN|Bearer [A-Za-z0-9]{20,}/],
    ];
    for (const [what, pattern] of leaks) check(!pattern.test(everything), `no recorded payload or log line carries ${what}`, pattern.test(everything) ? "FOUND ONE" : "swept clean");
    const bodies = recordedSends(stateDir).map((row) => String(row.payload?.aps?.alert?.body ?? "")).filter((body) => body.length > 0);
    check(bodies.every((body) => body.length <= 140), "and no notification body is longer than the host's own ceiling", `${bodies.length} bodies, longest ${Math.max(0, ...bodies.map((body) => body.length))} characters`);
  }

  if (MODE === "console") {
    // ===========================================================================================
    // --console: the Notifications card, the deep link and the absent-module boot, in real Chrome.
    // ===========================================================================================
    const require = createRequire(import.meta.url);
    let chromium = null;
    let why = "";
    // Two places, because a detached worktree has no .cache of its own: playwright is installed in
    // the main working copy and is never in the repo, so a gate run out of a worktree has to be able
    // to find it there. GROK_BOT_PLAYWRIGHT_DIR overrides both.
    for (const dir of [PW_DIR, ...(process.env.GROK_BOT_PLAYWRIGHT_DIR ? [] : [path.resolve("/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright")])]) {
      try { chromium = require(path.join(dir, "node_modules", "playwright-core")).chromium; info(`playwright-core from ${dir}`); break; }
      catch (error) { why = `${dir}: ${String(error?.message).slice(0, 70)}`; }
    }
    if (chromium == null) { skip("a real browser could be started", `playwright-core could not be loaded (${why}); nothing below was measured`); throw new NothingToMeasure("no browser"); }

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    const page = await (await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height },
      deviceScaleFactor: PHONE.deviceScaleFactor,
      isMobile: PHONE.isMobile,
      hasTouch: PHONE.hasTouch,
      userAgent: `${PHONE_UA} ${UA_GATE}`,
    })).newPage();
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(String(error?.message ?? error)));

    await front.edge.storeFor(front.t).register({ deviceId: "gate-phone-1", platform: "ios", token: "gate-token-for-the-card", sub: "", name: "the gate's iPhone" });

    console.log("\n== the console boots, at 390x844");
    await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: within(45_000) });
    const live = await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(45_000) }).then(() => true).catch(() => false);
    check(live, "the console boots with push-settings.js loaded", live ? "window.__machineRoomAdapter is up" : "the adapter never appeared");
    const published = await page.evaluate(() => typeof window.__pushSettings?.mount === "function");
    check(published, "and the module published itself on the seam", `window.__pushSettings.mount is ${published ? "a function" : "absent"}`);

    // =============================================================================================
    // CONSOLE-ATTR-1, IN A REAL BROWSER ON A REAL BOOT, because a unit test slicing app.js proves the
    // string is written and not that the page carries it.
    //
    // THE DEFECT THIS CLOSES. The desktop shell's injected reader tries, per selector, the attribute's
    // VALUE, then a number anywhere in the text, then -- failing both -- the number of elements the
    // selector matched. `data-needs-you-count` was on the pill with no value, and the pill is in the
    // markup and matches even while it is hidden and empty, so a console with ZERO agents waiting
    // reported 1. That reader is run here, verbatim in its own shape, against the live DOM.
    // =============================================================================================
    console.log("\n== the three hooks a shell reads off this page");
    const hooks = await page.evaluate(() => {
      const slot = document.querySelector("[data-needs-you-count]");
      // The desktop shell's own three readings, in its own order (src-tauri/src/inject.js).
      const firstInteger = (text) => { const m = /-?\d+/.exec(String(text ?? "")); return m == null ? null : Number(m[0]); };
      const nodes = slot == null ? [] : [slot];
      const read = nodes.length === 0 ? null
        : firstInteger(nodes[0].getAttribute("data-needs-you-count"))
          ?? firstInteger(nodes[0].textContent)
          ?? nodes.length;
      return {
        present: slot != null,
        attribute: slot?.getAttribute("data-needs-you-count") ?? null,
        text: (slot?.textContent ?? "").trim(),
        hidden: slot?.hidden === true,
        readsAs: read,
        talk: document.querySelectorAll("[data-talk-button]").length,
        talkIsTheVoiceButton: document.querySelector("[data-talk-button]")?.id ?? "",
        cards: [...document.querySelectorAll("[data-needs-you-card]")].map((node) => ({
          id: node.getAttribute("data-card-id"),
          agent: node.getAttribute("data-agent"),
          title: node.getAttribute("data-title"),
        })),
      };
    });
    check(hooks.present && hooks.attribute !== null && /^-?\d+$/.test(String(hooks.attribute)),
      "the roster pill carries data-needs-you-count with a NUMBER in it",
      `attribute "${hooks.attribute}", text "${hooks.text}", hidden ${hooks.hidden}`);
    check(hooks.readsAs === Number(hooks.attribute),
      "and the shell's own reader answers that number rather than falling through to a node count",
      `the reader answers ${hooks.readsAs}; before this it answered ${hooks.text.length === 0 ? 1 : "the text's number"} for the same page`);
    check(hooks.talk === 1 && hooks.talkIsTheVoiceButton === "voice-talk",
      "the talk button carries data-talk-button",
      `${hooks.talk} element(s), id "${hooks.talkIsTheVoiceButton}"`);
    // Every pending card in the open conversation, or none: this console boots on whatever
    // conversation the shared box happens to be showing, so an empty list is an honest answer and a
    // card that IS drawn has to be complete.
    const broken = hooks.cards.filter((card) => !card.id || !card.agent || card.agent === "agent" || /^entry-\d+$/.test(card.id));
    check(broken.length === 0,
      "and every pending card carrying the marker carries a durable id and agent with it",
      hooks.cards.length === 0
        ? "no pending card is drawn in the conversation this boot opened, which is an honest zero on a shared box"
        : `${hooks.cards.length} card(s), ${broken.length} incomplete`);
    info(`the page read: count "${hooks.attribute}", ${hooks.cards.length} pending card marker(s), ${hooks.talk} talk hook`);

    if (!live) {
      notReached("the console never came up",
        "the Notifications card appears inside Settings",
        "and every card kind the server knows has a switch a thumb can reach",
        "and every control on the card is 16px or more, so iOS does not zoom the page",
        "and saving it answers in one word",
        "and the device list shows the registered phone");
    } else {
      console.log("\n== how a phone reaches Settings at all");
      // MEASURED FIRST, because the answer decides how the rest of this mode has to be run. At 390x844
      // `.shelf-utilities` computes display:none (styles.css, inside the 690px block) and the gear is the
      // ONLY control bound to openSettings (app.js:6662). So on a phone there is no route into Settings
      // whatsoever -- not a cramped one, none -- and that is as true of the Mail card, the job bus card
      // and the endpoint picker as it is of this one.
      //
      // It is pre-existing, it lives in two files this item does not own, and it already has owners:
      // MOBILE-2 moves the needs-you count into the window bar and PHONE-IA-1 is the six-screen phone
      // shape. So it is filed as MOBILE-2c against the phone pane with this measurement, and REPORTED
      // here rather than asserted: a FAIL on somebody else's stylesheet in this gate would read as a
      // defect in the card, which is the opposite of what was measured.
      // SETTINGS-2 corrects the claim this leg used to make. MOBILE-2c's row said there is NO phone
      // route into Settings, and that is measured wrong: #shelf-settings is 0x0 because
      // .shelf-utilities is display:none at 390px, but the TOP-BAR gear #settings-button is 44x44 at
      // (336,42) on the same page and opens the panel. So both are read, and the leg is about whether
      // a thumb has ANY way in rather than about one of the two controls.
      const route = await page.evaluate(() => {
        const gear = document.getElementById("shelf-settings");
        const top = document.getElementById("settings-button");
        const shelf = document.querySelector(".shelf-utilities");
        const box = gear?.getBoundingClientRect();
        const topBox = top?.getBoundingClientRect();
        const laid = (rect) => rect != null && rect.width > 0 && rect.height > 0;
        return {
          gear: gear != null,
          shelfDisplay: shelf ? getComputedStyle(shelf).display : "absent",
          shelfGear: laid(box),
          topGear: laid(topBox) ? `${Math.round(topBox.width)}x${Math.round(topBox.height)} at (${Math.round(topBox.x)},${Math.round(topBox.y)})` : null,
          reachable: laid(box) || laid(topBox),
          others: [...document.querySelectorAll("button, a")].filter((node) => /settings/i.test(node.getAttribute("aria-label") ?? node.textContent ?? "")).length,
        };
      });
      info(`at ${PHONE.width}x${PHONE.height} .shelf-utilities computes display:${route.shelfDisplay} so #shelf-settings is ${route.shelfGear ? "laid out" : "0x0"}, and the top-bar gear #settings-button is ${route.topGear ?? "not laid out"}; ${route.others} control(s) on the page mention settings at all`);
      if (!route.reachable) {
        skip("the Notifications card can be opened by a thumb at this width",
          `neither gear is laid out at ${PHONE.width}px: .shelf-utilities is display:${route.shelfDisplay} and #settings-button has no box either`);
      } else {
        check(true, "the Notifications card can be opened by a thumb at this width",
          route.topGear ? `the top-bar gear is ${route.topGear} and hit-testable` : "the shelf gear is laid out and hit-testable");
      }

      console.log("\n== the Notifications card, opened at a phone viewport and measured there");
      // SETTINGS-2: opened THROUGH THE PHONE ROUTE, at the phone viewport, because there is one. This
      // used to widen the window to 1440 first and press the shelf gear, on the belief that no phone
      // route existed; the top-bar gear is 44x44 at this width and the sheet it opens is what a person
      // actually sees, so measuring the card inside a desktop-width panel that was then shrunk was
      // measuring a layout nobody gets.
      await page.click("#settings-button");
      // SETTINGS-2: Settings opens on General and paints ONE body at a time, and this card is the
      // Notifications body. Pressing that entry is what a person does; the card mounts into that
      // body's own [data-push-mount] slot, which is still structure and still not a string of copy.
      await page.waitForSelector("[data-settings-surface]", { timeout: within(20_000) }).catch(() => {});
      await page.click('[data-settings-nav="notifications"]').catch(() => {});
      const card = await page.waitForSelector("[data-push-settings]", { timeout: within(20_000) }).catch(() => null);
      check(card != null, "the Notifications card appears inside Settings", card == null ? "no [data-push-settings] section after pressing the gear" : "appended to the panel's own settings list");

      if (card == null) {
        notReached("the card did not appear",
          "and every card kind the server knows has a switch a thumb can reach",
          "and every control on the card is 16px or more, so iOS does not zoom the page",
          "and saving it answers in one word",
          "and the device list shows the registered phone");
      } else {
        await page.waitForFunction(() => document.querySelectorAll("[data-push-kind]").length > 0, { timeout: within(15_000) }).catch(() => {});
        // The viewport was never widened, so there is nothing to take back down: the card was opened
        // and is measured at the same phone size a person holds.
        await page.waitForTimeout(300);

        // EVERY switch hit-tested at its own centre, which is the lesson verify-mobile's drawers leg paid
        // for: page.click() calls scrollIntoViewIfNeeded first and passes on controls a thumb can never
        // reach. Three of eight conversation cards shipped dead behind exactly that.
        const reach = await page.evaluate((kinds) => {
          const out = [];
          for (const kind of kinds) {
            const node = document.querySelector(`[data-push-kind="${kind}"]`);
            if (node == null) { out.push({ kind, drawn: false }); continue; }
            node.scrollIntoView({ block: "center" });
            const box = node.getBoundingClientRect();
            const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            out.push({ kind, drawn: true, reachable: node.contains(at) || node === at, w: Math.round(box.width), h: Math.round(box.height), landed: at?.tagName ?? "nothing" });
          }
          return out;
        }, PUSH_CARD_KINDS);
        const missing = reach.filter((row) => !row.drawn).map((row) => row.kind);
        const blocked = reach.filter((row) => row.drawn && !row.reachable).map((row) => `${row.kind} lands on ${row.landed}`);
        check(missing.length === 0 && blocked.length === 0, "and every card kind the server knows has a switch a thumb can reach",
          missing.length > 0 ? `not drawn: ${missing.join(", ")}` : blocked.length > 0 ? `drawn but unreachable: ${blocked.join("; ")}` : `${reach.length} switches, each answering its own centre at ${PHONE.width}x${PHONE.height} (${reach.map((row) => `${row.w}x${row.h}`).join(", ")})`);

        // DOOR-1's rule, applied to this item's own card: iOS zooms the layout viewport on focus for any
        // control under 16px, and a select is a control. A card that zoomed the console the moment
        // somebody set their quiet hours would undo the front door's whole fix on the screen after it.
        const fonts = await page.evaluate(() => [...document.querySelectorAll("[data-push-settings] select, [data-push-settings] input, [data-push-settings] textarea")]
          .map((node) => ({ tag: node.tagName.toLowerCase(), px: Number.parseFloat(getComputedStyle(node).fontSize) })));
        const small = fonts.filter((row) => row.px < 16);
        check(fonts.length > 0 && small.length === 0, "and every control on the card is 16px or more, so iOS does not zoom the page",
          fonts.length === 0 ? "the card has no controls to measure" : small.length > 0 ? small.map((row) => `${row.tag} at ${row.px}px`).join(", ") : `${fonts.length} control(s), smallest ${Math.min(...fonts.map((row) => row.px))}px`);

        console.log("\n== saving it");
        // SET the two switches rather than PRESS them. This gate shares one push state directory with
        // every earlier run of itself, so "click it once and it will be off" is only true on a state
        // nobody has touched -- and measured on grok-bot-local-vm 2026-09-10, widget was already off
        // from a previous run, so the single press turned it ON and the assertion below read true and
        // called the surface broken. A switch is set to the value the leg is about, from whatever it
        // was found on, and the press is skipped when it is already there.
        const setSwitch = async (selector, want) => {
          const now = await page.$eval(selector, (node) => node.getAttribute("aria-pressed") === "true").catch(() => null);
          if (now === null) { info(`${selector} is not on the card, so it was not set`); return; }
          if (now !== want) await page.click(selector);
          info(`${selector} was ${now}, wanted ${want}`);
        };
        await setSwitch('[data-push-kind="widget"]', false);
        await setSwitch("[data-push-quiet]", true);
        await page.click("[data-push-save]");
        const note = await page.waitForFunction(() => document.querySelector("[data-push-note]")?.textContent?.trim().length > 0, { timeout: within(15_000) }).then(async () => await page.$eval("[data-push-note]", (node) => node.textContent.trim())).catch(() => "");
        check(note === "Saved.", "and saving it answers in one word", note || "nothing was written into the note");
        const stored = await ask("GET", "/push/settings");
        check(stored.body?.settings?.kinds?.widget === false && stored.body?.settings?.quietHours?.on === true,
          "and the switches come back off the relay, not out of the page", JSON.stringify(stored.body?.settings?.kinds ?? {}).slice(0, 120));
        check(Number.isFinite(stored.body?.settings?.utcOffsetMinutes), "and the browser's own offset went with it, so quiet hours mean the person's clock", `UTC offset ${stored.body?.settings?.utcOffsetMinutes} minutes`);

        console.log("\n== the device list");
        const shown = await page.$$eval("[data-push-revoke]", (nodes) => nodes.map((node) => ({ id: node.dataset.pushRevoke, label: node.textContent.trim() })));
        check(shown.length === 1 && shown[0].id === "gate-phone-1", "and the device list shows the registered phone", JSON.stringify(shown));
        const onScreen = await page.evaluate(() => document.querySelector("[data-push-settings]")?.textContent ?? "");
        check(!onScreen.includes("gate-token-for-the-card"), "and no device token is anywhere on the screen", "the card's own text is clean");
        // The known divergence is ON the card, where a customer comparing two numbers can read it.
        check(/counts cards/.test(onScreen) && /counts conversations/.test(onScreen), "and the card says in plain words why the app's number can differ from this console's", "both sentences are on screen");
      }
    }

    console.log("\n== the deep link");
    // The https fallback, which is the one a tap lands on when the app is not installed. The shape is
    // this item's; the twelve-line boot parse that reveals the entry is item B's.
    // The LAST agent on the roster, not the first. The console selects a default on boot, and on this
    // box the default is the first row, so a link naming the first agent would pass whether or not any
    // parse ran. Naming the last one makes the leg mean something.
    const roster = rosterOf(await gw("listAgents", {}).catch(() => null));
    const linkAgent = roster.at(-1) ?? null;
    if (linkAgent == null) skip("the https deep link opens the console on the named conversation", "this box has no conversation to land on");
    else {
      const tailForLink = await gw("getAgentTranscriptTail", { id: linkAgent.id, limit: 5 }).catch(() => null);
      const entry = (tailForLink?.entries ?? []).at(-1)?.id ?? "";
      const link = `${FRONT}/?agent=${encodeURIComponent(linkAgent.id)}&entry=${encodeURIComponent(entry)}`;
      // Back to the phone: the card legs above took the viewport up to 1440 to reach the gear, and a
      // deep link is tapped on a phone.
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: within(45_000) });
      const up = await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(45_000) }).then(() => true).catch(() => false);
      check(up, "the https deep link opens the console", up ? `landed on ${link.replace(FRONT, "")}` : "the console did not come up on the link");
      if (up) {
        const landed = await page.evaluate((want) => {
          const selected = document.querySelector(".worker-card.is-active, .worker-card[aria-selected=true], [data-context-id].is-active");
          return { on: selected?.dataset?.contextId ?? selected?.dataset?.agentId ?? "", want, revealed: document.querySelector(`[data-entry-id="${want.entry}"]`) != null };
        }, { agent: linkAgent.id, entry });
        if (landed.on === linkAgent.id) check(true, "and the named conversation is the one selected", `${landed.on.slice(0, 8)} is on screen`);
        else skip("and the named conversation is the one selected", `the console opened on ${landed.on ? landed.on.slice(0, 8) : "its default conversation"}: the boot parse that reads ?agent= and ?entry= is item B's and is not in this worktree. The link's SHAPE is proved above and in the unit suite`);
        if (entry.length > 0 && landed.revealed) check(true, "and the entry the card names is revealed", entry);
        else skip("and the entry the card names is revealed", "item B's boot parse is what reveals and flashes it; this gate proves the link carries the entry id");
      }
    }

    console.log("\n== with the module absent");
    // CONSOLE-4's lesson as a gate leg rather than a comment: backgrounds.js destructured a missing
    // global and took the picker down. The module is blocked at the network, which is exactly what a
    // deploy that did not ship the file looks like.
    const bare = await (await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height },
      deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: PHONE.isMobile, hasTouch: PHONE.hasTouch,
      userAgent: `${PHONE_UA} ${UA_GATE}`,
    })).newPage();
    const bareErrors = [];
    bare.on("pageerror", (error) => bareErrors.push(String(error?.message ?? error)));
    await bare.route("**/push-settings.js", (route) => route.abort());
    await bare.goto(FRONT, { waitUntil: "domcontentloaded", timeout: within(45_000) });
    const bareLive = await bare.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(45_000) }).then(() => true).catch(() => false);
    check(bareLive, "the console still boots with push-settings.js absent", bareLive ? "the adapter is up without it" : "the console did not come up");
    if (bareLive) {
      // The TOP-BAR gear, not the shelf one. MOBILE-2c's row says there is no phone route into
      // Settings; measured on grok-bot-local-vm at 390x844 in real Chrome, #settings-button is 44x44
      // at (336,42) and opens the panel, while #shelf-settings is 0x0 because .shelf-utilities is
      // display:none. So this leg needs no viewport change at all, and a resize plus a press on a
      // control that was hidden a frame ago is exactly how it failed to open.
      await bare.click("#settings-button");
      const bareSurface = await bare.waitForSelector("[data-settings-surface]", { timeout: within(20_000) }).catch(() => null);
      if (bareSurface == null) {
        info(`the panel did not open in the bare context: ${JSON.stringify(await bare.evaluate(() => ({
          dialog: document.getElementById("panel-dialog")?.open ?? null,
          gear: Boolean(document.getElementById("settings-button")),
          settingsModule: typeof window.__mrSettings,
          pushModule: typeof window.__pushSettings,
          accountModule: typeof window.__accountMenu,
          scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")),
        })))}`);
      }
      // SETTINGS-2 retarget, and a better leg than the one it replaces. `.settings-list` belongs to
      // the operator's card stack now, which a customer never sees, so waiting for it here would be
      // waiting for something this leg is not about. What is asserted instead is what a person would
      // see: the nav still lists Notifications, that body is still drawn, no card is mounted into it
      // because the module that mounts one was blocked, and nothing threw.
      const surface = bareSurface;
      // A LOCATOR, not an element handle. The nav is rebuilt the moment the session answer lands, so
      // a handle taken the instant an entry appears is detached a frame later and clicking it throws
      // "Element is not attached to the DOM" straight through the run's own catch, ending the gate on
      // a line that has nothing to do with what it was measuring. Measured here on 2026-09-10.
      const notifications = bare.locator('[data-settings-nav="notifications"]');
      await notifications.waitFor({ state: "visible", timeout: within(10_000) }).catch(() => {});
      const listed = (await notifications.count()) > 0 ? notifications : null;
      if (listed != null) { await listed.click({ timeout: within(15_000) }).catch(() => {}); await bare.waitForTimeout(1200); }
      const bareState = await bare.evaluate(() => ({
        body: document.querySelector('[data-settings-section="notifications"]') != null,
        card: document.querySelector("[data-push-settings]") != null,
        rows: document.querySelectorAll("[data-setting-row]").length,
      }));
      check(surface != null && listed != null && bareState.body && !bareState.card,
        "and Settings simply has one fewer card",
        surface == null ? "the panel did not open" : `nav lists Notifications ${listed != null}, body drawn ${bareState.body}, card ${bareState.card}`);
      await bare.click('[data-settings-nav="general"]').catch(() => {});
      await bare.waitForTimeout(800);
      const stillWhole = await bare.evaluate(() => document.querySelectorAll('[data-settings-section="general"] [data-setting-row]').length);
      check(stillWhole > 0, "and every other section is whole without it", `${stillWhole} row(s) on General`);
      check(bareErrors.length === 0, "and nothing threw on the way", bareErrors.length === 0 ? "no page errors" : bareErrors.slice(0, 2).join(" · "));
    }
    check(consoleErrors.length === 0, "and nothing threw with the module loaded either", consoleErrors.length === 0 ? "no page errors" : consoleErrors.slice(0, 2).join(" · "));
  }
} catch (error) {
  if (error instanceof NothingToMeasure) info(`stopped early: ${error.message}`);
  else { failures += 1; console.log(`  FAIL  the run itself — ${String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ")}`); }
} finally {
  await shutdown();
}

console.log(`\nverify-push --${MODE}: ${passes} pass, ${failures} fail, ${skips} skip · grok-bot-local-vm on this Mac${MODE === "console" ? ` at ${PHONE.width}x${PHONE.height}` : ""} · stub sender`);
process.exit(failures > 0 ? 1 : 0);
