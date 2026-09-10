#!/usr/bin/env node
// verify-cost.mjs -- COST-1, what the console costs a phone, in a real browser with CDP capture.
//
// THE CEILINGS, on DECODED bytes at 390x844 on grok-bot-local-vm:
//
//     first paint        250 KiB of /api
//     idle               100 KiB a minute
//     working            600 KiB a minute
//
// DECODED AND NOT WIRE, deliberately. Decoded is what the phone parses and what makes a local number
// comparable to an R750 one: production compresses (br on /login, gzip on /auth/state, measured at
// console.titanium.bot) and the local relay did not, so one outline read measures 1,210 KiB here and
// about 37 KiB live. Wire is printed beside decoded every time, and nothing is ever decided on it.
//
// THE THIRD CEILING EXISTS BECAUSE THE WORST TRAFFIC IN THE PRODUCT IS INVISIBLE TO AN IDLE GATE.
// With the open agent's status `working`, OUTLINE_WORKING_MAX_AGE_MS (gateway-adapter.js) re-reads
// the whole conversation outline every five seconds, which on the long-lived agent was 1,210.4 KiB a
// time, about 14.5 MiB a minute. So it is gated, not assumed.
//
// THE MEASURED BASELINE THIS IS BEATING, grok-bot-local-vm, 390x844, 2026-09-09, real Chrome,
// CDP capture, relay spawned from this worktree:
//
//     boot                 268 requests   4,029.7 KiB decoded
//       /api                47 calls        548.7 KiB   (1,683.7 KiB more on selecting the 1,578-item agent)
//       page assets         55             1,905.2 KiB   (app.js downloaded TWICE, 981.9 KiB)
//       noVNC              165             1,575.4 KiB   (two whole clients, 39% of boot, COST-2)
//       SSE                  1                 0.4 KiB
//     60 s idle             44 requests      647.0 KiB over 4 ticks
//       of which getAgentWorkflows 452.2 KiB: the same 86-skill catalogue, whole, four times,
//       for a panel that is not open.
//
// WHAT THE SECOND BOOT IS FOR. Every asset answered `cache-control: no-store` and every one of them
// came down again. That is the cache leg.
//
// USAGE, two invocations so each fits the 300 s ceiling:
//   node scripts/verify-cost.mjs --paint --idle
//   node scripts/verify-cost.mjs --working --cache --novnc --desktop
//   node scripts/verify-cost.mjs --paint --url https://console.titanium.bot    read-only, CONSOLE_BEARER set
//
// HOW THE RELAY-SIDE HALF IS REACHED. ui/api-diet.mjs and ui/asset-cache.mjs are loaded by
// ui/relay-hooks.mjs, which is item A's file. Until that lands on this tree the gate puts the two
// modules in a SHAPING PROXY in front of the relay, calling them with exactly the seam's own
// signatures -- shapeApiAnswer(method, args, headers, bytes) on a 200 only, assetPolicy(file, url, req)
// with the 304 decision, stampHtml(html, url) -- and says so in its own output, in these words: the
// payloads are the box's own, the browser is real and the bytes are real, and the one thing these
// numbers do not prove is the wiring in ui/server.mjs, which is item A's gate leg rather than this
// one's. Once ui/relay-hooks.mjs exists the proxy is not used for the measurement at all and the relay
// is read directly. Either way the mode is printed on every run.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBoxLock } from "./lib/box-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGS = ["paint", "idle", "working", "cache", "novnc", "desktop"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-cost.mjs (--paint | --idle | --working | --cache | --novnc | --desktop | --all)");
  console.log("       [--url https://console.titanium.bot]  read-only, CONSOLE_BEARER in the environment");
  console.log("       [--agent <id>]   the conversation the paint and working legs open; default the heaviest on the box");
  console.log("");
  console.log("  --paint    first paint on a NAMED conversation, under 250 KiB of decoded /api");
  console.log("  --idle     60 s untouched, up to three windows, under 100 KiB a quiet minute, plus a hidden page costing nothing");
  console.log("  --working  60 s with the open agent actually working, under 600 KiB a minute");
  console.log("  --cache    a second boot in the same browser pays round trips, not bytes");
  console.log("  --novnc    the two noVNC clients, printed as an unowned leg and never hidden in the ceiling");
  console.log("  --desktop  1440x900 does not move by one pixel, diet on against diet off");
  process.exit(2);
}

// ---- the ceilings, in one place so the failure message can print them ---------------------------
const PAINT_CEILING_KIB = Number(process.env.GROK_BOT_PAINT_CEILING_KIB ?? 250);
const IDLE_CEILING_KIB = Number(process.env.GROK_BOT_IDLE_CEILING_KIB ?? 100);
const WORKING_CEILING_KIB = Number(process.env.GROK_BOT_WORKING_CEILING_KIB ?? 600);

const URL_TARGET = value("url");
const READ_ONLY = URL_TARGET != null;
// Every /api call with its timestamp and its bytes. On a box three waves share, the difference
// between "the console asked four times" and "three heartbeats landed inside the window" is a
// timeline, and guessing at it is how a day goes to three wrong root causes.
const TRACE = flag("trace");
const MACHINE = READ_ONLY ? "the R750 through console.titanium.bot" : "grok-bot-local-vm (this Mac)";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(repoRoot, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/cost-shots";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const STATE_DIR = process.env.SAND_UI_STATE_DIR ?? path.join(repoRoot, "ui");
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_COST_BUDGET_MS ?? 285_000);
let deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(1, Math.min(ms, budgetLeft()));

const PHONE = { w: 390, h: 844, name: "390x844" };
const DESKTOP = { w: 1440, h: 900, name: "1440x900" };
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 titanbot-gate/verify-cost.mjs";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 titanbot-gate/verify-cost.mjs";

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kib = (n) => (n / 1024).toFixed(1);
mkdirSync(SHOTS, { recursive: true });

// ================================================================================================
// the relay under test, and the shaping proxy that stands in for item A's hook seam
// ================================================================================================

const HOOK_SEAM = path.join(repoRoot, "ui/relay-hooks.mjs");
const SEAM_PRESENT = existsSync(HOOK_SEAM);

const freePort = () => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startRelay(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["ui/server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1", SAND_UI_STATE_DIR: STATE_DIR, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const origin = `http://127.0.0.1:${port}`;
  const stop = Date.now() + 40_000;
  for (;;) {
    try { if ((await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not yet */ }
    if (Date.now() > stop) { child.kill("SIGKILL"); throw new Error("the relay from this worktree did not come up"); }
    await sleep(300);
  }
  return { origin, stop: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
}

// The two modules, in front of the relay, doing exactly what ui/relay-hooks.mjs will do from inside
// it: shapeApiAnswer on every /api answer, assetPolicy and stampHtml on the console's own files.
// Everything else -- /events, /vnc, the relay's JSON routes -- is piped through untouched.
async function startShapingProxy(relayOrigin, { diet = true } = {}) {
  const { shapeApiAnswer } = await import(path.join(repoRoot, "ui/api-diet.mjs"));
  const { assetPolicy, stampHtml } = await import(path.join(repoRoot, "ui/asset-cache.mjs"));
  const consoleDir = path.join(repoRoot, "ui/machine-room");
  const upstream = new URL(relayOrigin);
  const ASSET = /\.(css|js|mjs|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|map|webmanifest|txt|md)$/;

  const fetchUpstream = (req, body, onHead) => new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: upstream.host };
    // The relay answers plain text; this proxy owns the encoding, so it never asks for one upstream.
    delete headers["accept-encoding"];
    delete headers["if-none-match"];
    const out = httpRequest(
      { hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
      (res) => {
        if (onHead?.(res) === "piped") { resolve(null); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    out.on("error", reject);
    if (body != null && body.length > 0) out.write(body);
    out.end();
  });

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const isApi = req.method === "POST" && url.pathname.startsWith("/api/");
      // index.html and "/" are the same file and it is never stamped on disk, so its own response keeps
      // whatever the relay said (no-store): the stamps inside it move every time an asset does.
      const isHtml = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      const isAsset = req.method === "GET" && ASSET.test(url.pathname) && !url.pathname.startsWith("/vnc/") && !url.pathname.startsWith("/api/");
      const isAvatar = req.method === "GET" && url.pathname.startsWith("/avatars/");
      const streamed = !(isApi || isHtml || isAsset || isAvatar);
      try {
        const answer = await fetchUpstream(req, body, streamed
          ? (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); return "piped"; }
          : null);
        if (answer == null) return;
        const headers = { ...answer.headers };
        delete headers["content-length"];
        delete headers["transfer-encoding"];

        // EXACTLY ui/relay-hooks.mjs's shapes, so what this proxy measures is what the seam will do:
        // shapeApiAnswer(method, args, headers, bytes) -> {bytes, headers}, on a 200 only;
        // assetPolicy(file, url, req) -> {headers, status}; stampHtml(html, url) -> string.
        if (isApi && diet && answer.status === 200) {
          const shaped = shapeApiAnswer(url.pathname.slice(5), body.toString("utf8"), req.headers, answer.body.toString("utf8"));
          res.writeHead(200, { ...headers, ...shaped.headers });
          return res.end(shaped.bytes);
        }
        if (isAvatar && diet && answer.status === 200) {
          const policy = assetPolicy(url.pathname, url, req.headers);
          if (policy.status === 304) { res.writeHead(304, { ...headers, ...policy.headers }); return res.end(); }
          res.writeHead(200, { ...headers, ...policy.headers });
          return res.end(answer.body);
        }
        if ((isAsset || isHtml) && diet && answer.status === 200) {
          const file = path.resolve(consoleDir, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/(machine-room\/)?/, ""));
          if (file.startsWith(path.resolve(consoleDir) + path.sep)) {
            const policy = assetPolicy(file, url, req.headers);
            if (policy.status === 304) { res.writeHead(304, { ...headers, ...policy.headers }); return res.end(); }
            if (isHtml) {
              res.writeHead(200, { ...headers, ...policy.headers });
              return res.end(Buffer.from(stampHtml(answer.body.toString("utf8"), consoleDir), "utf8"));
            }
            res.writeHead(200, { ...headers, ...policy.headers });
            return res.end(answer.body);
          }
        }
        res.writeHead(answer.status, headers);
        return res.end(answer.body);
      } catch (error) {
        res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

// ================================================================================================
// the browser and the capture
// ================================================================================================

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
let browser = null;
const pageErrors = [];

function bucketOf(pathname) {
  if (pathname.startsWith("/api/")) return "api";
  if (pathname.startsWith("/vnc/")) return "novnc";
  if (pathname === "/events") return "sse";
  if (pathname.startsWith("/avatars/")) return "avatars";
  // The relay's own JSON routes: /model, /endpoints, /subscriptions, /auth/state, /connectors,
  // /job-bus/*, /mail/*. Named apart from /api so neither number can hide inside the other.
  if (/\.(css|js|mjs|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|map|webmanifest|txt|md)$/.test(pathname)
    || pathname === "/" || pathname === "/index.html") return "assets";
  return "relay";
}

// One capture over one page, startable and resettable, so a leg can say "from here".
async function capture(page, context) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const rows = new Map();
  let t0 = Date.now();
  cdp.on("Network.requestWillBeSent", (e) => {
    let pathname = "/";
    try { pathname = new URL(e.request.url).pathname; } catch { /* data: and blob: */ }
    rows.set(e.requestId, { pathname, method: e.request.method, body: e.request.postData ?? "", decoded: 0, wire: 0, at: Date.now() - t0, status: 0, bucket: bucketOf(pathname) });
  });
  cdp.on("Network.responseReceived", (e) => { const r = rows.get(e.requestId); if (r) { r.status = e.response.status; r.cf = e.response.headers?.["cf-cache-status"] ?? null; r.cc = e.response.headers?.["cache-control"] ?? e.response.headers?.["Cache-Control"] ?? null; } });
  cdp.on("Network.dataReceived", (e) => { const r = rows.get(e.requestId); if (r) { r.decoded += e.dataLength; r.wire += e.encodedDataLength; } });
  cdp.on("Network.loadingFinished", (e) => { const r = rows.get(e.requestId); if (r && r.wire === 0) r.wire = e.encodedDataLength; });
  return {
    reset: () => { rows.clear(); t0 = Date.now(); },
    rows: () => [...rows.values()].map((r) => ({ ...r })),
  };
}

// Wait until the page has stopped asking for things. This is what a rect fingerprint needs and what
// two rounds of this gate learned the hard way: measured on 2026-09-10, comparing 1,272 rects across
// two boots found nine differing by ONE PIXEL on the roster's avatars, because the avatar versions are
// settled a beat AFTER first paint and the two boots were caught either side of that repaint. Waiting
// for images to load was not enough; waiting for the network to go quiet is.
async function quietFor(cap, ms = 3000, capMs = 25_000) {
  const until = Date.now() + Math.min(capMs, Math.max(1000, budgetLeft() - 5000));
  let seen = cap.rows().length;
  let quietSince = Date.now();
  for (;;) {
    await sleep(500);
    const now = cap.rows().length;
    if (now !== seen) { seen = now; quietSince = Date.now(); }
    if (Date.now() - quietSince >= ms) return true;
    if (Date.now() >= until) return false;
  }
}

const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0);
const bucket = (rows, name) => rows.filter((r) => r.bucket === name);
const methodOf = (row) => {
  if (!row.pathname.startsWith("/api/")) return row.pathname;
  let label = row.pathname.slice(5);
  try { const args = JSON.parse(row.body || "{}"); if (args.id) label += `{${String(args.id).slice(0, 8)}}`; } catch { /* no args */ }
  return label;
};

function printSplit(rows, title) {
  const api = bucket(rows, "api");
  info(`${title}: ${rows.length} requests, ${kib(sum(rows, "decoded"))} KiB decoded / ${kib(sum(rows, "wire"))} KiB wire, on ${MACHINE} at ${PHONE.name}`);
  for (const name of ["api", "assets", "novnc", "sse", "avatars", "relay"]) {
    const part = bucket(rows, name);
    if (part.length === 0) continue;
    info(`  ${name.padEnd(7)} ${String(part.length).padStart(4)} requests  ${kib(sum(part, "decoded")).padStart(9)} KiB decoded  ${kib(sum(part, "wire")).padStart(9)} KiB wire`);
  }
  const byMethod = new Map();
  for (const row of api) {
    const key = methodOf(row);
    const held = byMethod.get(key) ?? { n: 0, decoded: 0 };
    held.n += 1; held.decoded += row.decoded;
    byMethod.set(key, held);
  }
  const worst = [...byMethod.entries()].sort((a, b) => b[1].decoded - a[1].decoded).slice(0, 8);
  for (const [key, held] of worst) info(`    ${String(held.n).padStart(2)}x ${kib(held.decoded).padStart(8)} KiB  ${key}`);
  return api;
}

async function phonePage(origin, { query = "", viewport = PHONE, ua = IPHONE_UA } = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.w, height: viewport.h },
    deviceScaleFactor: viewport === PHONE ? 3 : 1,
    isMobile: viewport === PHONE,
    hasTouch: viewport === PHONE,
    userAgent: ua,
    extraHTTPHeaders: BEARER ? { authorization: `Bearer ${BEARER}` } : {},
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const cap = await capture(page, context);
  await page.goto(`${origin}/${query}`, { waitUntil: "load", timeout: within(60_000) });
  return { context, page, cap };
}

// Live, not demo. A demo page asks the host for nothing, so every number it produces is a lie.
async function waitLive(page) {
  await page.waitForFunction(() => window.__machineRoomLive === true, { timeout: within(90_000) }).catch(() => {});
  const live = await page.evaluate(() => window.__machineRoomLive === true);
  const error = await page.evaluate(() => window.__machineRoomError ?? null);
  return { live, error };
}

const snapshot = (page) => page.evaluate(() => {
  const s = window.__machineRoomAdapter?.getSnapshot?.();
  if (!s) return null;
  const active = s.activeContext;
  const record = [...(s.workers ?? []), ...(s.rooms ?? [])].find((r) => r.id === active?.id) ?? null;
  return {
    active,
    name: record?.name ?? null,
    messages: (record?.messages ?? []).length,
    status: record?.status ?? null,
    workers: (s.workers ?? []).map((w) => ({ id: w.id, name: w.name, status: w.status, lastActivityAt: w.lastActivityAt ?? 0 })),
  };
});

// THE BOX IS SHARED. Waves D and V recreate it, and a wave that releases the lock the moment its own
// command returns hands over a container that is up but whose gateway is not answering yet. Measured
// twice in this session: the lock came free, listAgents answered nothing, and every leg would have
// skipped -- or worse, measured an offline page and called the number a result. So the box is waited
// for, by name, and a box that never answers is a named skip rather than a zero.
async function waitForBox(origin, ms = 120_000) {
  const until = Date.now() + Math.min(ms, Math.max(0, budgetLeft() - 60_000));
  for (;;) {
    try {
      const r = await fetch(`${origin}/api/listAgents`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(BEARER ? { authorization: `Bearer ${BEARER}` } : {}) },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      const agents = JSON.parse(await r.text());
      if (Array.isArray(agents) && agents.length > 0) return agents.length;
    } catch { /* the box is still coming up */ }
    if (Date.now() >= until) return 0;
    await sleep(5000);
  }
}

// The heaviest conversation on the box: the one whose outline is biggest, which is the number that
// swings a paint measurement 3x on the same box in the same minute. Asked of the relay directly so
// the choice is made before a browser is opened.
async function heaviestAgent(origin) {
  const named = value("agent");
  const ask = async (method, args) => {
    const r = await fetch(`${origin}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(BEARER ? { authorization: `Bearer ${BEARER}` } : {}) },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  };
  const agents = await ask("listAgents");
  if (!Array.isArray(agents) || agents.length === 0) return null;
  if (named != null) {
    const one = agents.find((a) => a.id === named);
    return one ? { id: one.id, name: one.name, items: null } : null;
  }
  let best = null;
  for (const a of agents) {
    if (a.isGroup) continue;
    const outline = await ask("getConversationOutline", { id: a.id });
    const items = Array.isArray(outline) ? outline.length : 0;
    if (best == null || items > best.items) best = { id: a.id, name: a.name, items };
  }
  return best;
}

// ================================================================================================
// the legs
// ================================================================================================

// WHERE FIRST PAINT ENDS, and why it matters. The window used to be "navigate, then sleep eight
// seconds", and on a shared box that silently swept two whole heartbeats into the number: measured
// here on 2026-09-09, 76 /api calls with twenty-one keys asked four times each, while the page itself
// had painted the conversation once. First paint ends when the PERSON can read the conversation --
// the adapter is live, the active record has messages, and the transcript has drawn rows for them --
// and every tick after that belongs to the idle leg, which has its own ceiling. The seconds after
// the boundary are printed too, so nothing is hidden by moving the line.
const PAINTED = () => {
  const s = window.__machineRoomAdapter?.getSnapshot?.();
  const active = s?.activeContext;
  if (!active) return false;
  const record = [...(s.workers ?? []), ...(s.rooms ?? [])].find((r) => r.id === active.id);
  if (!record || (record.messages ?? []).length === 0) return false;
  return document.querySelectorAll("#transcript [data-message-id], #transcript .message").length > 0;
};

async function legPaint(origin, heavy) {
  console.log(`\n-- PAINT: first paint on a named conversation, ceiling ${PAINT_CEILING_KIB} KiB of decoded /api`);
  if (heavy == null) { skip("paint", "the relay listed no agents, so there is no conversation to open"); return; }
  info(`the conversation: ${heavy.name} (${heavy.id}), ${heavy.items == null ? "item count not read" : `${heavy.items} outline items`}`);
  const { context, page, cap } = await phonePage(origin, { query: `?agent=${encodeURIComponent(heavy.id)}` });
  const { live, error } = await waitLive(page);
  if (!live) { skip("paint", `the page fell back to the offline view (${error ?? "no reason given"}), so its numbers mean nothing`); await context.close(); return; }
  const painted = await page.waitForFunction(PAINTED, { timeout: within(45_000) }).then(() => true).catch(() => false);
  const rows = cap.rows();
  const api = printSplit(rows, painted ? "first paint" : "first paint (the transcript never drew, so this is the window it had)");
  const shot = await snapshot(page);
  info(`landed on ${shot?.name} (${shot?.active?.id?.slice(0, 8)}), ${shot?.messages} messages drawn, paint boundary at ${Math.max(0, ...api.map((r) => r.at))} ms`);
  check(painted, "the conversation is on screen", painted ? "the transcript drew its rows" : "nothing was drawn inside the window");
  check(shot?.active?.id === heavy.id, "first paint landed on the conversation the link named", `${shot?.active?.id?.slice(0, 8) ?? "nothing"} vs ${heavy.id.slice(0, 8)}`);
  const decoded = sum(api, "decoded");
  check(decoded <= PAINT_CEILING_KIB * 1024, `first paint is under ${PAINT_CEILING_KIB} KiB of decoded /api`,
    `${kib(decoded)} KiB decoded over ${api.length} calls, ${kib(sum(api, "wire"))} KiB wire, on ${MACHINE} at ${PHONE.name} (548.7 KiB over 47 calls before this ship, plus 1,683.7 on selecting this agent)`);
  const dupes = new Map();
  for (const row of api) dupes.set(methodOf(row), (dupes.get(methodOf(row)) ?? 0) + 1);
  const repeated = [...dupes.entries()].filter(([, n]) => n > 1);
  info(`duplicate /api keys inside the paint window: ${repeated.length}${repeated.length ? ` — ${repeated.map(([k, n]) => `${n}x ${k}`).join(", ")}` : ""} (12 before this ship)`);
  if (TRACE) for (const row of api.sort((a, b) => a.at - b.at)) info(`    ${String(row.at).padStart(6)} ms  ${kib(row.decoded).padStart(8)} KiB  ${methodOf(row)}`);

  // The seconds after the boundary, named rather than folded in: this is the tick the idle ceiling
  // owns, measured here only so moving the line cannot hide anything.
  cap.reset();
  await sleep(8000);
  const after = bucket(cap.rows(), "api");
  info(`the 8 s after first paint: ${after.length} /api calls, ${kib(sum(after, "decoded"))} KiB decoded (the idle leg's ceiling, not this one's)`);
  await page.screenshot({ path: path.join(SHOTS, "cost-paint.png") }).catch(() => {});
  await context.close();
}

async function legIdle(origin, heavy) {
  console.log(`\n-- IDLE: 60 s untouched, twice, ceiling ${IDLE_CEILING_KIB} KiB a minute`);
  const { context, page, cap } = await phonePage(origin, { query: heavy ? `?agent=${encodeURIComponent(heavy.id)}` : "" });
  const { live, error } = await waitLive(page);
  if (!live) { skip("idle", `the page fell back to the offline view (${error ?? "no reason given"})`); await context.close(); return; }
  // The settle, printed rather than skipped past. A cold browser learns this box's avatar versions
  // here -- once, ever, per browser -- and that is not a per-minute cost, so it must not land inside a
  // per-minute ceiling. Waiting it out and naming what it cost is the honest way to keep it out.
  await page.waitForFunction(PAINTED, { timeout: within(45_000) }).catch(() => {});
  cap.reset();
  await sleep(14_000);
  const settleApi = bucket(cap.rows(), "api");
  const settleAvatars = settleApi.filter((r) => /getAgentAvatar/.test(r.pathname));
  info(`settle after paint: ${settleApi.length} /api calls, ${kib(sum(settleApi, "decoded"))} KiB decoded, of which ${kib(sum(settleAvatars, "decoded"))} KiB is ${settleAvatars.length} avatar version read(s) this browser will never make again`);

  // MORE THAN ONCE, because one window is not a measurement: 4 ticks and 655.3 KiB and 6 ticks and
  // 982.0 KiB were measured six minutes apart on this same box before this ship.
  //
  // AND AN IDLE MINUTE HAS TO ACTUALLY BE ONE. The heartbeat is 15 s, so a page nobody touches on a
  // box nobody is driving ticks four times a minute. Waves D and V share this box, and measured here
  // on 2026-09-10 one window ticked THIRTEEN times -- the /events stream firing because another
  // wave's agents were working -- which is a page watching a busy box, not an idle page. Failing the
  // ceiling on that would be reporting somebody else's traffic as this item's regression. So a window
  // with more ticks than the heartbeat can explain is recorded and printed but does NOT decide the
  // verdict; the verdict needs a genuinely quiet window, and if none comes the leg skips by name.
  //
  // The PER-TICK cost is printed for every window, quiet or not, because that is the number the diet
  // actually changed and it does not care how busy the box is.
  // TWO MARKERS OF A MINUTE THAT WAS NOT IDLE, because the tick count alone was not enough. Measured
  // on 2026-09-10: a window with five ticks and 29.8 KiB a tick passed the tick test and was still not
  // an idle minute, because another wave had minted an agent on this box and reloadRosterInner answered
  // that by re-running the whole of hydrate. getHostSettings and listAllAutomations are asked by hydrate
  // and by nothing else, so either of them inside the window is that, by name rather than by inference.
  const QUIET_TICKS = 6;
  const HYDRATE_ONLY = /\/api\/(getHostSettings|listAllAutomations|getTeachRecordingStatus)$/;
  const runs = [];
  for (let n = 0; n < 3; n += 1) {
    if (budgetLeft() < 75_000) { info(`only ${Math.round(budgetLeft() / 1000)} s of budget left, so idle took ${n} window(s)`); break; }
    cap.reset();
    await sleep(60_000);
    const rows = cap.rows();
    const api = bucket(rows, "api");
    const ticks = api.filter((r) => /\/api\/getTrays$/.test(r.pathname)).length;
    const rebuilt = api.some((r) => HYDRATE_ONLY.test(r.pathname));
    const run = { decoded: sum(api, "decoded"), wire: sum(api, "wire"), calls: api.length, ticks, rebuilt, all: sum(rows, "decoded"), requests: rows.length };
    run.quiet = ticks <= QUIET_TICKS && !rebuilt;
    runs.push(run);
    info(`idle window ${n + 1}: ${ticks} ticks, ${api.length} /api calls, ${kib(run.decoded)} KiB decoded / ${kib(run.wire)} KiB wire`
      + `, ${kib(run.decoded / Math.max(1, ticks))} KiB a tick against 161.7 KiB a tick before this ship`
      + `; whole page ${rows.length} requests and ${kib(run.all)} KiB`
      + `${run.quiet ? "" : ` — NOT an idle minute (${ticks > QUIET_TICKS ? `${ticks} ticks against the heartbeat's 4` : "the roster changed and hydrate re-ran"}), so this window does not decide the verdict`}`);
    if (runs.filter((one) => one.quiet).length >= 2) break;
  }
  if (runs.length === 0) { skip("idle", "no budget left for a 60 s window"); await context.close(); return; }
  const quiet = runs.filter((one) => one.quiet);
  if (quiet.length === 0) {
    skip("the idle ceiling", `none of the ${runs.length} window(s) was an idle minute (${runs.map((one) => `${one.ticks} ticks${one.rebuilt ? " and a roster change" : ""}`).join(", ")}; the heartbeat alone is 4) because another wave was driving this box. The per-tick cost, which does not depend on the box, is ${runs.map((one) => `${kib(one.decoded / Math.max(1, one.ticks))} KiB`).join(", ")} against 161.7 KiB before this ship`);
  } else {
    const busiest = quiet.reduce((a, b) => (b.decoded > a.decoded ? b : a));
    check(busiest.decoded <= IDLE_CEILING_KIB * 1024, `60 idle seconds cost under ${IDLE_CEILING_KIB} KiB of decoded /api`,
      `${kib(busiest.decoded)} KiB at the busier of ${quiet.length} quiet window(s), ${busiest.ticks} ticks, on ${MACHINE} at ${PHONE.name} (646.7 KiB over 4 ticks before this ship)`);
  }

  // HIDDEN. Measured before this ship: hiding the document changed nothing at all -- 44 requests and
  // 654.8 KiB in the next sixty seconds. The timers that are NOT this adapter's are named rather than
  // claimed: cloud-browser.js has its own beat and app.js has a problem-report beat, and neither is
  // this item's to stop.
  if (budgetLeft() < 75_000) { skip("hidden", `only ${Math.round(budgetLeft() / 1000)} s of budget left; run --idle in its own invocation for this leg`); }
  else {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    // THREE SECONDS BEFORE THE WINDOW OPENS, because a request cannot be un-sent. A tick that was
    // already in flight when the page went away still lands: measured on a busy box, hiding the
    // document in the middle of a reloadActive logged its six remaining loadContext reads afterwards,
    // and calling that "a backgrounded page asking for something" would be blaming the adapter for
    // physics. What this leg measures is that no tick STARTS after the page is hidden.
    await sleep(3000);
    cap.reset();
    await sleep(60_000);
    const hidden = cap.rows();
    const hiddenApi = bucket(hidden, "api");
    const ours = hiddenApi.filter((r) => !/listCloudBrowserSessions|listProblemReports/.test(r.pathname));
    const theirs = hiddenApi.filter((r) => /listCloudBrowserSessions|listProblemReports/.test(r.pathname));
    info(`hidden 60 s: ${hidden.length} requests, ${kib(sum(hidden, "decoded"))} KiB; ${ours.length} of them this adapter's, ${theirs.length} from timers it does not own (cloud-browser.js and the problem-report beat)`);
    check(ours.length === 0, "a backgrounded page starts no tick of this adapter's", `${ours.length} call(s): ${[...new Set(ours.map(methodOf))].slice(0, 6).join(", ") || "none"} (44 requests and 654.8 KiB before this ship)`);

    cap.reset();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // TWO MEASUREMENTS, because two different things happen when a phone comes back. The resume's own
    // catch-up read goes out immediately; the fresh EventSource then gets a frame from this gateway
    // straight away and the 900 ms debounce schedules ANOTHER read off it. That second read is the
    // stream doing its job, not a second catch-up, and conflating the two made this leg fail on
    // correct behaviour. So the catch-up is counted inside 600 ms -- shorter than the debounce can
    // possibly be -- and what coming back COSTS is measured over four seconds and bounded in bytes,
    // which is the part a person on a phone actually pays for.
    await sleep(600);
    const immediate = bucket(cap.rows(), "api").filter((r) => /\/api\/getTrays$/.test(r.pathname)).length;
    check(immediate === 1, "coming back to the page is exactly one catch-up read", `${immediate} getTrays inside 600 ms, which is shorter than the 900 ms stream debounce`);
    await sleep(3400);
    const back = bucket(cap.rows(), "api");
    const trays = back.filter((r) => /\/api\/getTrays$/.test(r.pathname)).length;
    // THE COUNT, NOT THE BYTES. Coming back costs the catch-up read, and one more off the fresh
    // EventSource's first frame 900 ms later. That second read is NOT collapsed into the first on
    // purpose: a frame arriving after the catch-up's request went out may be about something that
    // changed after that snapshot, and swallowing it would hold a card for up to fifteen seconds until
    // the next heartbeat. So what is asserted is the number of reads this adapter makes, which is
    // this item's to control, and the bytes are printed, which are the box's: measured 27.9 KiB on a
    // quiet box and 109.0 KiB on one another wave was driving hard, for the same two reads.
    info(`coming back cost ${kib(sum(back, "decoded"))} KiB over ${back.length} calls in 4 s, which is the box's number, not this adapter's`);
    check(trays <= 2, "and coming back is the catch-up plus at most the stream's first frame", `${trays} reload(s) in 4 s, neither of them dropped (a hidden minute used to cost 654.8 KiB on its own)`);
  }
  await context.close();
}

async function legWorking(origin, heavy) {
  console.log(`\n-- WORKING: 60 s with the open agent actually working, ceiling ${WORKING_CEILING_KIB} KiB a minute`);
  if (READ_ONLY) { skip("working", "this leg sends a prompt, and --url runs read-only"); return; }
  if (heavy == null) { skip("working", "no conversation to work in"); return; }
  const { context, page, cap } = await phonePage(origin, { query: `?agent=${encodeURIComponent(heavy.id)}` });
  const { live, error } = await waitLive(page);
  if (!live) { skip("working", `the page fell back to the offline view (${error ?? "no reason given"})`); await context.close(); return; }
  await sleep(6000);

  // A real turn, because `working` is the host's word and nothing here may fake it. The shell step is
  // what keeps the agent busy long enough to measure: an outline re-read every five seconds is the
  // traffic this ceiling exists for.
  await page.evaluate((id) => window.__machineRoomAdapter.sendMessage({ kind: "worker", id }, "Run exactly this in the shell and then reply with one word, done: sleep 45; echo finished"), heavy.id);
  let working = false;
  const until = Date.now() + Math.min(40_000, budgetLeft() - 70_000);
  while (Date.now() < until) {
    const shot = await snapshot(page);
    if (shot?.status === "working") { working = true; break; }
    await sleep(3000);
  }
  if (!working) {
    skip("working", "the box never reported the agent working (no model endpoint took the turn), so there is nothing to measure rather than a number to invent");
    await context.close();
    return;
  }
  cap.reset();
  // How much of the minute the agent was ACTUALLY working, sampled rather than assumed. A turn that
  // finishes in ten seconds makes this an idle minute wearing a working label, and the ceiling it is
  // measured against is then the wrong ceiling.
  const started = Date.now();
  let workingMs = 0;
  let samples = 0;
  while (Date.now() - started < 60_000 && budgetLeft() > 5000) {
    await sleep(3000);
    samples += 1;
    if ((await snapshot(page))?.status === "working") workingMs += 3000;
  }
  const rows = cap.rows();
  const api = printSplit(rows, "60 working seconds");
  const decoded = sum(api, "decoded");
  const outlines = api.filter((r) => /getConversationOutline/.test(r.pathname));
  info(`the agent reported working for about ${Math.round(workingMs / 1000)} s of the ${samples * 3} s sampled`);
  info(`${outlines.length} outline read(s) in the minute, ${kib(sum(outlines, "decoded"))} KiB of them; OUTLINE_WORKING_MAX_AGE_MS is 5 s, so a minute of real work is about 12`);
  if (workingMs < 20_000) {
    // Not a number to invent, and not a number to leave unsaid either. The mechanism's own cost IS
    // measured: one projected outline read on this agent, times the cadence the host's own constant
    // sets, plus the tick traffic this gate measured in its idle leg. That arithmetic is PLANNED and
    // says so; the 600 KiB ceiling stays gated and unexercised until a model endpoint on this box
    // takes a turn.
    // The per-read figure has to be a REAL read. The one outline read inside that minute was very
    // likely a digest hit of a few bytes, which would make the arithmetic below nonsense, so the size
    // is asked for once, directly, with the same lean header the console sends.
    let perRead = 0;
    try {
      const r = await fetch(`${origin}/api/getConversationOutline`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-titan-projection": "lean", ...(BEARER ? { authorization: `Bearer ${BEARER}` } : {}) },
        body: JSON.stringify({ id: heavy.id }),
        signal: AbortSignal.timeout(30_000),
      });
      perRead = Buffer.byteLength(await r.text());
    } catch { perRead = 0; }
    skip("the working ceiling", `the agent worked for only about ${Math.round(workingMs / 1000)} s of the minute, so this was not a working minute and its ${kib(decoded)} KiB is not the number the 600 KiB ceiling is about.`
      + ` PLANNED, not measured: twelve outline reads at ${kib(perRead)} KiB is ${kib(perRead * 12)} KiB, plus about 56 KiB of tick traffic, so about ${kib(perRead * 12 + 56 * 1024)} KiB a working minute against 14.5 MiB unprojected`);
  } else {
    check(decoded <= WORKING_CEILING_KIB * 1024, `60 working seconds cost under ${WORKING_CEILING_KIB} KiB of decoded /api`,
      `${kib(decoded)} KiB over ${api.length} calls on ${MACHINE} at ${PHONE.name}, about ${Math.round(workingMs / 1000)} s of it working (about 14.5 MiB a minute unprojected)`);
  }
  await context.close();
}

async function legCache(origin) {
  console.log("\n-- CACHE: a second boot in the same browser pays round trips, not bytes");
  const { context, page, cap } = await phonePage(origin);
  await waitLive(page);
  await sleep(6000);
  const first = cap.rows().filter((r) => r.bucket === "assets");
  info(`first boot: ${first.length} asset requests, ${kib(sum(first, "decoded"))} KiB decoded / ${kib(sum(first, "wire"))} KiB wire`);
  const stamped = first.filter((r) => r.cc != null && /immutable/.test(r.cc));
  const revalidating = first.filter((r) => r.cc != null && /no-cache/.test(r.cc));
  const publicly = first.filter((r) => r.cc != null && /public/i.test(r.cc));
  info(`of those: ${stamped.length} immutable, ${revalidating.length} revalidating, ${first.filter((r) => /no-store/.test(r.cc ?? "")).length} no-store`);
  check(publicly.length === 0, "no asset is cacheable by a shared cache", `${publicly.length} answered public, on an origin where every asset 401s unauthenticated and the relay writes no vary`);
  const cf = [...new Set(first.map((r) => r.cf).filter(Boolean))];
  if (cf.length > 0) info(`cf-cache-status seen: ${cf.join(", ")} — BYPASS is the intended answer for a private response on an authenticated origin, not a failure`);

  cap.reset();
  await page.goto(`${origin}/`, { waitUntil: "load", timeout: within(60_000) });
  await waitLive(page);
  await sleep(6000);
  const second = cap.rows().filter((r) => r.bucket === "assets");
  const fell = sum(first, "wire") === 0 ? 0 : 1 - sum(second, "wire") / sum(first, "wire");
  info(`second boot: ${second.length} asset requests, ${kib(sum(second, "decoded"))} KiB decoded / ${kib(sum(second, "wire"))} KiB wire, ${second.filter((r) => r.status === 304).length} of them 304`);
  check(fell > 0.9, "a second boot's asset bytes fall by more than 90%", `${(fell * 100).toFixed(1)}% (${kib(sum(first, "wire"))} KiB to ${kib(sum(second, "wire"))} KiB wire) on ${MACHINE}`);

  // And the stamp is not a promise made in bad faith: touch a file and the bytes come back.
  const touched = path.join(repoRoot, "ui/machine-room/tokens.css");
  try {
    const before = readFileSync(touched);
    const now = new Date();
    utimesSync(touched, now, now);
    const stat = statSync(touched);
    info(`touched tokens.css (mtime ${stat.mtimeMs}, ${before.byteLength} bytes)`);
    cap.reset();
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: within(60_000) });
    await sleep(4000);
    const third = cap.rows().filter((r) => r.bucket === "assets" && /tokens\.css/.test(r.pathname));
    const refetched = third.some((r) => r.status === 200 && r.decoded > 0);
    check(refetched, "a touched file's stamp changes and its bytes come back", `${third.map((r) => `${r.status} ${r.decoded}b`).join(", ") || "tokens.css was not requested at all"}`);
  } catch (error) {
    skip("the touched-file half of the cache leg", String(error?.message ?? error));
  }
  await context.close();
}

async function legNovnc(origin) {
  console.log("\n-- NOVNC: an unowned leg, printed and never hidden inside the ceiling");
  const { context, page, cap } = await phonePage(origin);
  await waitLive(page);
  await sleep(8000);
  const rows = cap.rows();
  const novnc = bucket(rows, "novnc");
  const launches = rows.filter((r) => /\/box\/launch/.test(r.pathname));
  info(`noVNC at ${PHONE.name}: ${novnc.length} requests, ${kib(sum(novnc, "decoded"))} KiB decoded / ${kib(sum(novnc, "wire"))} KiB wire`);
  info(`that is ${sum(rows, "decoded") === 0 ? "0" : ((sum(novnc, "decoded") / sum(rows, "decoded")) * 100).toFixed(0)}% of this boot, and ${launches.length} POST /box/launch`);
  info("COST-2, owner the phone pane: two complete noVNC clients mount at phone width out of app.js:4529 and :5182, about three lines of guard in a file this wave does not own. 165 requests and 1,575.4 KiB measured, 39% of boot.");
  check(true, "the noVNC figure is printed beside the API figure", `${kib(sum(novnc, "decoded"))} KiB, excluded from the ceiling by name`);
  await context.close();
}

// Every rect OUTSIDE the transcript, plus the transcript's own frame, as numbers rather than a string.
//
// WHY NOT THE TRANSCRIPT'S CONTENTS. This leg boots the same console twice, forty seconds apart, with
// the diet on and then off, and waves D and V are driving agents on this box: measured on 2026-09-10,
// one pass drew 196 messages and the other 199, and 1,194 of 1,279 rects "moved" because the
// conversation had grown between the two reads. That is the box, not the layout. What the projection
// does to a transcript is proved where it can be proved exactly -- tests/api-diet.test.mjs weaves the
// real captured payload both ways and requires the same tool rows at the same positions with the same
// text -- and what this leg is for is the shell: the window bar, the roster, the panels, the
// transcript's own frame.
//
// AND WHY A TWO-PIXEL TOLERANCE rather than rect-for-rect equality. The roster draws a placeholder face
// and swaps the real one in a beat later, which is this item's own deliberate change, and a PNG and an
// SVG placeholder lay their wrapper out two pixels apart. Measured across three runs on 2026-09-10,
// every difference this leg ever found was exactly that: span.worker-avatar 47x47 against 45x45 and
// the twenty-one rects after it shifted by one. A real layout regression is not subtle -- the precedent
// this rule comes from is verify-mobile's own desktop leg, where a stray column track moved a capsule
// from 268 px to 227 px and 20 px to the left. So the tolerance is two pixels, the worst difference is
// printed every run, and a fourth pixel fails.
const RECTS = () => {
  const transcript = document.querySelector("#transcript");
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (transcript != null && el !== transcript && transcript.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cls = String(el.className || "").split(" ").filter(Boolean)[0] ?? "";
    out.push({
      key: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return out;
};

const RECT_TOLERANCE_PX = 2;

// The worst single-coordinate difference between two fingerprints, and what carried it.
function worstRectDrift(a, b) {
  if (a.length !== b.length) return { drift: Infinity, where: `${a.length} nodes against ${b.length}` };
  let worst = { drift: 0, where: "nothing moved" };
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].key !== b[i].key) return { drift: Infinity, where: `${a[i].key} against ${b[i].key} at ${i}` };
    for (const field of ["x", "y", "w", "h"]) {
      const drift = Math.abs(a[i][field] - b[i][field]);
      if (drift > worst.drift) {
        worst = { drift, where: `${a[i].key} ${field} ${a[i][field]} against ${b[i][field]}` };
      }
    }
  }
  return worst;
}

async function legDesktop(dietOrigin, plainOrigin) {
  console.log("\n-- DESKTOP: 1440x900 does not move by one pixel, and the page works with both modules absent");
  const read = async (origin) => {
    const { context, page, cap } = await phonePage(origin, { viewport: DESKTOP, ua: DESKTOP_UA });
    const { live } = await waitLive(page);
    // SETTLED FIRST, and settled means the network has gone quiet and every picture has loaded. The
    // avatar versions land a beat after first paint and repaint the roster, so a fingerprint taken
    // before that and one taken after differ by a pixel on every face -- content timing, not layout,
    // and a comparison that cannot tell them apart fails on correct behaviour.
    const quiet = await quietFor(cap, 3000);
    await page.waitForFunction(() => [...document.querySelectorAll("img")].every((img) => img.complete), { timeout: within(15_000) }).catch(() => {});
    await sleep(1000);
    if (!quiet) info(`${DESKTOP.name}: the page was still asking for things when the budget ran out, so this fingerprint may carry timing noise`);
    const rects = await page.evaluate(RECTS);
    const messages = (await snapshot(page))?.messages ?? null;
    await page.screenshot({ path: path.join(SHOTS, `cost-desktop-${origin === dietOrigin ? "diet" : "plain"}.png`) }).catch(() => {});
    await context.close();
    return { rects, live, messages };
  };
  const diet = await read(dietOrigin);
  const plain = await read(plainOrigin);
  info(`${DESKTOP.name}: ${diet.rects.length} shell rects with the diet, ${plain.rects.length} without it (the transcript's contents are excluded by name, see above)`);
  check(plain.live === true, "the console comes up live with ui/api-diet.mjs and ui/asset-cache.mjs doing nothing", "the absent-module case is a leg, not a comment");
  check(diet.live === true, "and live with both of them shaping every answer");
  const worst = worstRectDrift(diet.rects, plain.rects);
  check(worst.drift <= RECT_TOLERANCE_PX, `${DESKTOP.name}'s shell does not move`,
    `worst difference ${worst.drift === Infinity ? "a different set of nodes" : `${worst.drift} px`} over ${diet.rects.length} rects, tolerance ${RECT_TOLERANCE_PX} px: ${worst.where}`);
  // And both drew a conversation. The counts are printed rather than compared: this box is shared and a
  // conversation that grew between the two boots is the box's doing, not the diet's.
  info(`${diet.messages} messages drawn with the diet, ${plain.messages} without${diet.messages === plain.messages ? "" : " — the conversation grew between the two boots, which is this box being shared"}`);
  check((diet.messages ?? 0) > 0 && (plain.messages ?? 0) > 0, "and a conversation is drawn either way", `${diet.messages} and ${plain.messages} messages`);
}

// ================================================================================================
// the run
// ================================================================================================

// Waves D and V share this box, so waiting for the lock is normal and can be long. The budget starts
// when the box is actually ours: a run that spent four minutes queueing and then skipped every leg
// for lack of time would report nothing and look like a pass.
const release = READ_ONLY ? () => {} : await acquireBoxLock({ what: "verify-cost.mjs", waitMs: 45 * 60_000, log: (line) => info(line) });
deadline = Date.now() + RUN_BUDGET_MS;
let relay = null;
let proxy = null;
let plainProxy = null;
let plainRelay = null;
try {
  console.log(`verify-cost.mjs — COST-1 on ${MACHINE}, budget ${Math.round(RUN_BUDGET_MS / 1000)} s, legs: ${chosen.join(" ")}`);
  console.log(`ceilings (decoded bytes): first paint ${PAINT_CEILING_KIB} KiB, idle ${IDLE_CEILING_KIB} KiB/min, working ${WORKING_CEILING_KIB} KiB/min`);

  let origin = URL_TARGET;
  let plainOrigin = URL_TARGET;
  if (!READ_ONLY) {
    relay = await startRelay();
    if (SEAM_PRESENT) {
      origin = relay.origin;
      info("ui/relay-hooks.mjs is present, so the relay is measured DIRECTLY: these are the shipped bytes.");
      // The absent-module side of the A/B, and the only honest way to build it once the seam is real:
      // move the two modules aside, start a second relay that therefore loads neither, and put them
      // back. Confined to this run, restored in a finally, and nothing else on the tree is touched.
      if (chosen.includes("desktop")) {
        const aside = ["ui/api-diet.mjs", "ui/asset-cache.mjs"].map((rel) => ({ from: path.join(repoRoot, rel), to: `${path.join(repoRoot, rel)}.aside` }));
        try {
          for (const one of aside) renameSync(one.from, one.to);
          plainRelay = await startRelay();
          plainOrigin = plainRelay.origin;
        } catch (error) {
          info(`the absent-module relay could not be started (${String(error?.message ?? error)}), so the desktop leg will compare the live relay with itself and say so`);
          plainOrigin = relay.origin;
        } finally {
          for (const one of aside) { try { renameSync(one.to, one.from); } catch { /* never moved */ } }
        }
      } else plainOrigin = relay.origin;
    } else {
      proxy = await startShapingProxy(relay.origin, { diet: true });
      plainProxy = await startShapingProxy(relay.origin, { diet: false });
      origin = proxy.origin;
      plainOrigin = plainProxy.origin;
      info("ui/relay-hooks.mjs is NOT on this tree yet, so ui/api-diet.mjs and ui/asset-cache.mjs are measured");
      info("through a shaping proxy in front of the relay, doing exactly what that seam will do from inside it.");
      info("The payloads are the box's own, the browser is real and the bytes are real; the one thing these");
      info("numbers do not prove is the wiring in ui/server.mjs, which is item A's file and item A's gate leg.");
    }
  } else {
    info("read-only against a live console: no relay is spawned and no proxy is used.");
  }

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const ready = await waitForBox(READ_ONLY ? origin : relay.origin);
  if (ready === 0) {
    for (const leg of chosen) skip(leg, "the box never answered listAgents inside the wait, so nothing here can be measured");
  } else {
    info(`the box answers: ${ready} agents on it`);
    const heavy = await heaviestAgent(READ_ONLY ? origin : relay.origin).catch(() => null);
    if (heavy != null) info(`heaviest conversation on the box: ${heavy.name} (${heavy.id})${heavy.items != null ? `, ${heavy.items} outline items` : ""}`);

    if (chosen.includes("paint")) await legPaint(origin, heavy);
    if (chosen.includes("idle")) await legIdle(origin, heavy);
    if (chosen.includes("working")) await legWorking(origin, heavy);
    if (chosen.includes("cache")) await legCache(origin);
    if (chosen.includes("novnc")) await legNovnc(origin);
    if (chosen.includes("desktop")) await legDesktop(origin, plainOrigin);
  }

  if (pageErrors.length > 0) {
    console.log("");
    for (const one of [...new Set(pageErrors)].slice(0, 6)) check(false, "the page threw", one.slice(0, 200));
  } else info("no page error on any leg");
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  proxy?.stop();
  plainProxy?.stop();
  plainRelay?.stop();
  relay?.stop();
  release();
}

console.log(`\n${passes} PASS / ${failures} FAIL / ${skips} SKIP — ${MACHINE}, ${PHONE.name} for every phone leg, screenshots in ${SHOTS}`);
process.exit(failures > 0 ? 1 : 0);
