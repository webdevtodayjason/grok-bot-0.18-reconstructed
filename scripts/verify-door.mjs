#!/usr/bin/env node
// verify-door.mjs -- DOOR-1 and STORE-1's server half, in a real browser at real device sizes.
//
// TWO ITEMS, ONE GATE, because they are one screen's worth of work: the page a customer meets, and the
// credential an app gets instead of meeting it.
//
// FOUR RULES THIS FILE IS WRITTEN UNDER.
//
//   THE WIDTH ASSERTION IS AGAINST visualViewport.width, NEVER innerWidth. Measured on
//   grok-bot-local-vm 2026-09-09: the old door laid out a 400 px document inside a 390 px device and
//   Chrome GREW window.innerWidth to 400 to match, so `scrollWidth <= innerWidth` PASSED on a page that
//   pans sideways in the hand. Both numbers are printed, so a divergence is visible rather than silently
//   passing. scripts/verify-mobile.mjs documented the wrong rule until this ship and now documents this
//   one.
//
//   CHROME CANNOT PROVE THE iOS ZOOM, AND THIS GATE DOES NOT CLAIM TO. visualViewport.scale stayed 1
//   through focus at both phone widths in real headless Chrome. iOS Safari's zoom-on-focus is defined in
//   terms of the focused control's computed font-size, so the evidence here is that size on EVERY
//   control plus the absent autofocus attribute plus document.activeElement being body on arrival. The
//   gate says that sentence out loud rather than printing a no-zoom it did not measure.
//
//   THE TOKEN LEGS PROVE BOTH HALVES, BECAUSE THEY PROVE DIFFERENT THINGS. A plain HTTP client sending
//   `Origin: capacitor://localhost` proves the preflight answers 204 with exactly that origin and no
//   allow-credentials -- which a browser would never let a test observe. A real page on a SECOND ORIGIN
//   in the same browser proves the end-to-end path a shell actually walks: mint, read a conversation,
//   hold /events with fetch plus a stream reader, revoke. Chrome is NEVER run with web security
//   disabled, which would hide the very header the leg exists to measure.
//
//   A TOKEN NEVER RIDES IN A URL AND IS NEVER PRINTED. The legs below hold bearers in variables and
//   print lengths and prefixes. /events is read with fetch plus a stream reader rather than EventSource,
//   because EventSource carries no header -- which is also exactly what docs/APPS.md tells the shells.
//
// USAGE
//   node scripts/verify-door.mjs --all                      every leg, one browser, one relay
//   node scripts/verify-door.mjs --door                     just the front door
//   node scripts/verify-door.mjs --all --url https://console.titanium.bot
//                                                           read-only against the live door; the token
//                                                           legs need DOOR_ACCOUNT/DOOR_PASSWORD
//
// The default target is a relay spawned from THIS worktree against grok-bot-local-vm, so the gate always
// measures the tree it lives in. It takes the shared box lock while it does, because waves D and V share
// that box, and the whole run fits inside the 300 s ceiling.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBoxLock } from "./lib/box-lock.mjs";
import { gateUserAgent } from "./gate-agent.mjs";

const LEGS = ["door", "cors", "app", "mobile"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const URL_TARGET = value("url");
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-door.mjs (--all | --door | --cors | --app | --mobile)");
  console.log("       [--url https://console.titanium.bot]   read-only; DOOR_ACCOUNT and DOOR_PASSWORD for the token legs");
  console.log("");
  console.log("  --door    16px on every control, no autofocus, viewport-fit, the palette, the mark, the width");
  console.log("  --cors    the preflight answers exactly the named origins, with no credentials, above the login gate");
  console.log("  --app     a page on a SECOND ORIGIN mints a bearer, reads a conversation, holds /events, revokes");
  console.log("  --mobile  scripts/verify-mobile.mjs --width, with the corrected rule, as a regression");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(repoRoot, ".cache/playwright");
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/door-shots";
const BUDGET_MS = Number(process.env.GROK_BOT_DOOR_BUDGET_MS ?? 250_000);
// THE CLOCK STARTS WHEN THE BOX IS OURS, NOT WHEN THE PROCESS STARTS. Waves D and V share this box and
// hold the lock for minutes at a time: measured 2026-09-10, this gate waited 310 s for
// verify-code-sandbox, by which point the whole budget was gone and `within()` clamped every timeout to
// 1 ms -- so the run reported "Timeout 1ms exceeded" on a page that was perfectly fine. A gate that
// reports a fault it did not see is worse than a slow one, so `startBudget()` is called after
// acquireBoxLock returns and the 300 s ceiling is measured from there.
let deadline = Date.now() + BUDGET_MS;
const startBudget = () => { deadline = Date.now() + BUDGET_MS; };
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(1, Math.min(ms, budgetLeft()));

const PHONES = [{ w: 390, h: 844, name: "390x844" }, { w: 430, h: 932, name: "430x932" }];
// SIGNIN-1. This gate knocks on a login door and on /auth/token, which is the same door wearing a
// different shape, so it says its own name at both. Derived rather than typed: scripts/gate-agent.mjs
// carries the prefix and the reason, and tests/gate-agent.test.mjs fails any gate that names a login
// path without importing it.
const GATE_AGENT = gateUserAgent(import.meta.url);
const IPHONE_UA = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 ${GATE_AGENT}`;

// The brand board's own values, so a drifted token is a failure here rather than a thing somebody
// notices on a screenshot. memory/titanium-bot-brand-system.md.
const MIDNIGHT = "rgb(9, 13, 20)";
const CYAN = "rgb(0, 200, 240)";

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (line) => console.log(`\n== ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
const shoot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
};

// ---- the relay under test ----------------------------------------------------------------------

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A copy of ui/*.mjs with an auth file of its own, the same shape tests/relay-tenant-support.mjs uses:
// the operator's own auth.json must not decide which branch of the door runs, and a gate must never
// write into his tree. The machine-room frontend is symlinked rather than copied, so the static legs
// read the real console.
const GATE_PASSWORD = "a door gate password nobody types";
async function relayCopy({ tenant }) {
  const { newAuthRecord, writeAuthFile } = await import(path.join(repoRoot, "ui/auth.mjs"));
  const dir = mkdtempSync(path.join(tmpdir(), "door-gate-"));
  for (const name of readdirSync(path.join(repoRoot, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repoRoot, "ui", name), path.join(dir, name));
  }
  const { symlinkSync } = await import("node:fs");
  try { symlinkSync(path.join(repoRoot, "ui/machine-room"), path.join(dir, "machine-room")); } catch { /* already */ }
  try { symlinkSync(path.join(repoRoot, "ui/index.html"), path.join(dir, "index.html")); } catch { /* already */ }
  writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(GATE_PASSWORD));
  // A control plane URL nothing answers at is what draws the tenant branch of the door: the page is
  // rendered without ever calling it, so a dead port is exactly the right fake here.
  const env = tenant ? { CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: "a".repeat(40) } : { CP_URL: "", CP_RELAY_TOKEN: "" };
  return { dir, env };
}

const relays = [];
async function startRelay({ tenant = false, extraEnv = {} } = {}) {
  const { dir, env } = await relayCopy({ tenant });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_UI_AUTH_FILE: "", SAND_UI_STATE_DIR: "", SAND_UI_ENDPOINTS_FILE: "",
      SAND_UI_TENANTS_FILE: "", TITAN_JOB_TOKEN: "",
      ...env, ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  child.stdout?.on("data", (chunk) => { boot += chunk; });
  child.stderr?.on("data", (chunk) => { boot += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const stop = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${origin}/auth/state`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not yet */ }
    if (Date.now() > stop) { child.kill("SIGKILL"); throw new Error(`the relay did not come up: ${boot.slice(-400)}`); }
    await sleep(250);
  }
  const handle = { origin, dir, boot: () => boot, stop: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
  relays.push(handle);
  return handle;
}

// ---- the browser -------------------------------------------------------------------------------

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
let browser = null;
const pageErrors = [];

async function phoneContext(phone) {
  const context = await browser.newContext({
    viewport: { width: phone.w, height: phone.h },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
  });
  context.on("page", (page) => page.on("pageerror", (e) => pageErrors.push(String(e))));
  return context;
}

// What the page says about itself, read in the page. Everything here is a computed value or an
// attribute, because those are what a browser's own behaviour is defined in terms of.
const DOOR = () => {
  const controls = [...document.querySelectorAll("input:not([type=hidden]), button, select, textarea")];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  const visual = Math.round(window.visualViewport?.width ?? window.innerWidth);
  return {
    controls: controls.map((el) => ({
      what: el.id || el.tagName.toLowerCase(),
      size: parseFloat(getComputedStyle(el).fontSize),
      ...rect(el),
    })),
    autofocusAttributes: document.querySelectorAll("[autofocus]").length,
    activeElement: document.activeElement === document.body ? "body" : (document.activeElement?.id || document.activeElement?.tagName || "?"),
    meta: document.querySelector('meta[name="viewport"]')?.content ?? "",
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    buttonBackground: getComputedStyle(document.querySelector("button")).backgroundColor,
    buttonColor: getComputedStyle(document.querySelector("button")).color,
    inlineSvgs: document.querySelectorAll("svg").length,
    // THE PAGE'S OWN subresources, which is what this leg is about: an asset path exempted from the
    // session check would be a hole in the thing the door exists to close. A script the EDGE injects
    // is not the page asking for anything -- measured on console.titanium.bot 2026-09-10, Cloudflare
    // Web Analytics adds static.cloudflareinsights.com/beacon.min.js to every page on the zone -- so
    // same-origin and relative references are counted and anything cross-origin is listed instead.
    subresources: [...document.querySelectorAll("img, script, link[rel=stylesheet]")]
      .map((el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "")
      .filter((one) => one.length > 0 && !one.startsWith("data:"))
      .filter((one) => { try { return new URL(one, location.href).origin === location.origin; } catch { return true; } }).length,
    injected: [...document.querySelectorAll("img, script, link[rel=stylesheet]")]
      .map((el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "")
      .filter((one) => one.length > 0 && !one.startsWith("data:"))
      .filter((one) => { try { return new URL(one, location.href).origin !== location.origin; } catch { return false; } }),
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    machineRoom: document.documentElement.outerHTML.includes("Machine Room"),
    email: document.querySelector("#email") != null,
    forms: document.querySelectorAll("form").length,
    buttons: document.querySelectorAll("button").length,
    visual,
    inner: window.innerWidth,
    docScrollWidth: document.scrollingElement.scrollWidth,
    pastEdge: [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > visual + 1 && getComputedStyle(el).visibility !== "hidden";
    }).map((el) => `${el.tagName.toLowerCase()}@${Math.round(el.getBoundingClientRect().right)}`),
    // The scale through a focus, recorded and NOT asserted on: see the rule at the top of this file.
    scale: window.visualViewport?.scale ?? 1,
  };
};

async function legDoor(origin, phone, { tenant }) {
  const context = await phoneContext(phone);
  const page = await context.newPage();
  await page.goto(`${origin}/login`, { waitUntil: "load", timeout: within(30_000) });
  const out = await page.evaluate(DOOR);
  const label = `${phone.name} ${tenant ? "(two doors)" : "(one door)"}`;
  const smallest = Math.min(...out.controls.map((one) => one.size));
  info(`${label}: ${out.controls.length} controls, smallest ${smallest}px, document scrollWidth ${out.docScrollWidth}, visual viewport ${out.visual}, innerWidth ${out.inner}`);

  const small = out.controls.filter((one) => one.size < 16);
  check(small.length === 0, `${label}: every control is at least 16px`,
    small.length > 0 ? small.map((one) => `${one.what} ${one.size}px`).join(", ") : "14px on every input and the button before this ship");

  const short = out.controls.filter((one) => one.h < 44);
  check(short.length === 0, `${label}: every control is at least 44px tall`,
    short.length > 0 ? short.map((one) => `${one.what} ${one.h}px`).join(", ") : `${out.controls.map((one) => one.h).join("/")}px`);

  // The two halves of the zoom evidence, since Chrome cannot raise an iPhone's zoom.
  check(out.autofocusAttributes === 0, `${label}: no autofocus attribute in the DOM`, `${out.autofocusAttributes}`);
  check(out.activeElement === "body", `${label}: nothing is focused on arrival, so nothing zooms on arrival`, out.activeElement);

  check(/viewport-fit=cover/.test(out.meta), `${label}: the viewport meta covers the notch`, out.meta);

  // AGAINST THE VISUAL VIEWPORT, NEVER innerWidth. The old door grew innerWidth to 400 on a 390 px
  // device, which is how the obvious assertion passed on a document that pans sideways.
  check(out.docScrollWidth <= out.visual + 1, `${label}: the document does not pan sideways`,
    `scrollWidth ${out.docScrollWidth} vs visual viewport ${out.visual}`
    + (out.inner !== out.visual ? ` — innerWidth says ${out.inner}, which is the number that hid this (400 vs 390 before this ship)` : ""));
  check(out.visual === phone.w, `${label}: the visual viewport is the device width`, `${out.visual}`);
  check(out.pastEdge.length === 0, `${label}: nothing is off the right edge`, out.pastEdge.slice(0, 4).join(", ") || "none");

  check(out.bodyBackground === MIDNIGHT, `${label}: the ground is Midnight`, `${out.bodyBackground} (want ${MIDNIGHT})`);
  check(out.buttonBackground === CYAN, `${label}: the button is Signal Cyan`, `${out.buttonBackground} (want ${CYAN})`);
  check(out.buttonColor === MIDNIGHT, `${label}: on Midnight text`, out.buttonColor);
  check(out.inlineSvgs >= 1, `${label}: the Ti mark is inline`, `${out.inlineSvgs} svg`);
  check(out.subresources === 0, `${label}: and the page asks for no asset of its own at all`, `${out.subresources}`);
  // Printed rather than asserted: it is the zone's setting and not this page's markup, and a gate
  // that failed on it would be reporting somebody else's decision as this door's defect. It is worth
  // reading, though: this is the one screen that is a credential form.
  if (out.injected.length > 0) info(`${label}: the edge injects ${out.injected.length} script(s) into this page: ${out.injected.join(", ")}`);
  check(/Titanium Bot/.test(out.title) && /Titanium *Bot/.test(out.h1), `${label}: the title and the heading name the product`, `"${out.title}" / "${out.h1}"`);
  check(out.machineRoom === false, `${label}: the string Machine Room appears nowhere`, out.machineRoom ? "it is still there" : "gone");
  check(out.forms === 1 && out.buttons === 1, `${label}: still one form and one button`, `${out.forms} form, ${out.buttons} button`);
  // Against a relay this gate STARTED, it chose the branch and so it asserts it. Against a live
  // console (--url) it gets whichever door that deployment has, so the email field is REPORTED. A
  // gate that asserted its own guess there would fail on a correct page.
  if (URL_TARGET == null) check(out.email === tenant, `${label}: the email field is drawn ${tenant ? "with" : "without"} a control plane`, `${out.email}`);
  else info(`${label}: this deployment draws the ${out.email ? "account door (email and password)" : "instance-password door"}`);

  // Focus a control and read the scale back. RECORDED, NOT ASSERTED: see the rule at the top.
  await page.focus("#password").catch(() => {});
  await sleep(200);
  const after = await page.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, focused: document.activeElement?.id ?? "" }));
  info(`${label}: visualViewport.scale ${out.scale} before focus and ${after.scale} after focusing ${after.focused || "nothing"} — `
    + "Chrome cannot raise an iPhone's zoom, so the evidence for it is the 16px computed size plus the absent autofocus, not this number");

  info(`${label}: ${await shoot(page, `door-${tenant ? "two" : "one"}-${phone.name}`)}`);
  await context.close();
}

// ---- CORS, with a plain HTTP client ------------------------------------------------------------
//
// Not in a browser, deliberately: a browser never hands a page the headers of a refused preflight, and
// those headers are the thing this leg exists to measure.

async function legCors(origin) {
  const ask = (headers, method = "OPTIONS", pathname = "/api/getHealth") =>
    fetch(`${origin}${pathname}`, { method, headers: { "user-agent": GATE_AGENT, ...headers } });

  for (const allowed of ["capacitor://localhost", "https://localhost"]) {
    const res = await ask({ origin: allowed, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" });
    check(res.status === 204, `a preflight from ${allowed} is answered above the login gate`, `HTTP ${res.status} (401 before this ship: there was no OPTIONS handler at all)`);
    check(res.headers.get("access-control-allow-origin") === allowed, `and names exactly that origin`, String(res.headers.get("access-control-allow-origin")));
    check(res.headers.get("access-control-allow-credentials") == null, `and never allows credentials`,
      "the cookie is SameSite=Strict and is never sent cross-site, so credentials would buy a shell nothing and cost this console its CSRF answer");
    check(/authorization/i.test(String(res.headers.get("access-control-allow-headers"))), "and admits the Authorization header", String(res.headers.get("access-control-allow-headers")));
    // THE EXPOSE LIST, BY NAME, and x-titan-digest is the name that matters. Only the headers on this
    // line are readable by cross-origin JavaScript and a missing one fails silently: headers.get
    // answers null, the adapter's memo is never filled, x-titan-if-digest is never sent, and every
    // idempotent read is downloaded whole on every tick -- which is the one mechanism the 100 KiB
    // idle ceiling rests on. It was missing on the R750 until 2026-09-10 and no gate looked.
    const exposed = String(res.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(",").map((one) => one.trim());
    for (const name of ["x-relay-auth", "etag", "x-titan-digest"]) {
      check(exposed.includes(name), `and exposes ${name} to cross-origin JavaScript`, String(res.headers.get("access-control-expose-headers")));
    }
    // INCLUDES origin, not equals it. A compressing edge adds Accept-Encoding of its own and that is
    // correct: what this assertion is about is that no shared cache can serve one origin's
    // access-control headers to another origin's request.
    check(String(res.headers.get("vary") ?? "").toLowerCase().split(",").map((one) => one.trim()).includes("origin"),
      "and varies on origin, so no shared cache crosses two origins", String(res.headers.get("vary")));
  }

  for (const liar of ["https://evil.example", "https://localhost.evil.example", "null"]) {
    const res = await ask({ origin: liar, "access-control-request-method": "POST" });
    check(res.headers.get("access-control-allow-origin") == null, `a preflight from ${liar} gets zero access-control headers`, `HTTP ${res.status}`);
  }

  // AND THE PATHS CORS IS NOT ON. Until 2026-09-10 these headers went on at the top of the request
  // entry and therefore on every route on this relay: measured live on console.titanium.bot, OPTIONS
  // /v1/jobs, /admin/login-ledger, /mail/send and /code/start each answered 204 with
  // access-control-allow-origin: capacitor://localhost. None of them is a path a shell calls and each
  // holds a credential of its own, so an app origin has no business being told it may talk to them.
  for (const pathname of ["/v1/jobs", "/admin/login-ledger", "/mail/send", "/code/start"]) {
    const res = await ask({ origin: "capacitor://localhost", "access-control-request-method": "POST" }, "OPTIONS", pathname);
    check(res.headers.get("access-control-allow-origin") == null,
      `a preflight to ${pathname} from an ALLOWED origin still gets no access-control headers`, `HTTP ${res.status}`);
  }

  // No Origin at all is not a CORS request: a native HTTP client sends none, and it has to keep working.
  const bare = await ask({}, "POST", "/auth/token");
  check(bare.headers.get("access-control-allow-origin") == null && bare.status !== 204,
    "a request with no Origin is answered exactly as it always was", `HTTP ${bare.status}`);
}

// ---- a page on a SECOND ORIGIN, which is what a bundled shell is ------------------------------

// A tiny origin that serves one page. It is a different scheme/host/port from the relay, so the browser
// treats every call it makes as cross-origin and enforces CORS for real -- which is the point. Chrome is
// never launched with web security disabled.
function startShellOrigin(html) {
  const server = httpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

const SHELL_PAGE = `<!doctype html><meta charset="utf-8"><title>shell</title><body><pre id="out">starting</pre>
<script>
// Everything a Capacitor shell does, in the order it does it. No EventSource and no bare <img>: both
// carry no header, which is exactly why docs/APPS.md tells a shell to use fetch and blob URLs.
window.__shell = async (relay, password) => {
  const log = [];
  const say = (line) => { log.push(line); document.getElementById("out").textContent = log.join("\\n"); };
  const mint = await fetch(relay + "/auth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, device: { name: "the gate's shell", platform: "ios" } }),
  });
  if (!mint.ok) return { ok: false, why: "mint " + mint.status, log };
  const minted = await mint.json();
  const auth = { authorization: "Bearer " + minted.token };
  say("minted " + minted.device.id);

  const agents = await fetch(relay + "/api/listAgents", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  // The BODY, not just the status. The relay spends 502 on two very different things: a gateway nothing
  // is listening on (a box mid-restart, which waves D and V cause) and a gateway that refused this
  // relay's bearer (a box recreated under a live relay, so the token it read at boot is stale). Both
  // are the box and neither is the token door, and a status alone cannot tell them apart -- which cost
  // three re-runs of this leg on 2026-09-09 before the body was printed.
  if (!agents.ok) return { ok: false, why: "listAgents " + agents.status + " " + (await agents.text()).slice(0, 200), log, token: minted.token, device: minted.device.id };
  // listAgents answers a BARE ARRAY of agents, measured against grok-bot-local-vm's gateway on
  // 2026-09-09: ten items, keys id/name/description/title/avatarDataUrl/... The object shapes are
  // tolerated in case a later host wraps it, but the array is what it really is.
  const roster = await agents.json();
  const list = Array.isArray(roster) ? roster : (roster?.agents ?? roster?.result?.agents ?? []);
  say("roster " + list.length);

  // A NAMED conversation, not whichever bot happens to be first. Other waves leave scratch bots on this
  // box ("Code gate ... delete me", "Unread probe ..."), and reading one of those measures nothing a
  // customer would do. The argument is id and not agentId: measured against grok-bot-local-vm's
  // gateway 2026-09-10, an agentId argument answers 500 "Cannot read properties of undefined (reading
  // startsWith)" for every bot, which is what ui/machine-room/gateway-adapter.js:2099 already knew.
  let outline = null;
  const named = list.find((one) => !/^(Code gate|Unread probe|push gate|New Agent|Diag Room)/i.test(String(one.name ?? ""))) ?? list[0];
  if (named != null) {
    const res = await fetch(relay + "/api/getConversationOutline", {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: named.id ?? named.agentId }),
    });
    const text = await res.text();
    let items = null;
    try { const parsed = JSON.parse(text); items = Array.isArray(parsed?.items) ? parsed.items.length : (Array.isArray(parsed) ? parsed.length : null); }
    catch { items = null; }
    outline = { status: res.status, bytes: text.length, items, name: String(named.name ?? ""), body: res.ok ? "" : text.slice(0, 160) };
    say("outline " + outline.status + " " + outline.bytes + " bytes");
  }

  // THE UNCHANGED-ANSWER PROTOCOL, FROM A BUNDLED ORIGIN, which is the only place it was never
  // measured and the only place it was broken. Two identical reads: the first has to hand this page a
  // READABLE x-titan-digest (cross-origin JS can only see the headers the relay exposes by name, and a
  // missing name fails silently), and the second, carrying it back, has to cost 20 bytes instead of the
  // whole payload. Without it every idle tick re-downloads everything, which is 6.5x the idle ceiling.
  let digest = null;
  if (named != null) {
    const body = JSON.stringify({ id: named.id ?? named.agentId });
    const head = { ...auth, "content-type": "application/json", "x-titan-projection": "lean" };
    const one = await fetch(relay + "/api/getConversationOutline", { method: "POST", headers: head, body });
    const oneText = await one.text();
    const seen = one.headers.get("x-titan-digest");
    // What this page can see at all, which is the list the relay's expose header decides.
    const visible = [];
    one.headers.forEach((_value, name) => visible.push(name));
    let twoBytes = null;
    let unchanged = false;
    if (seen) {
      const two = await fetch(relay + "/api/getConversationOutline", { method: "POST", headers: { ...head, "x-titan-if-digest": seen }, body });
      const twoText = await two.text();
      twoBytes = twoText.length;
      unchanged = twoText.indexOf("__unchanged") >= 0;
    }
    digest = { readable: seen != null, head: String(seen ?? "").slice(0, 8), visible: visible.sort().join(", "), first: oneText.length, second: twoBytes, unchanged };
    say("digest " + (seen == null ? "NOT READABLE" : digest.head) + ", " + digest.first + " then " + digest.second + " bytes");
  }

  // /events with fetch plus a stream reader, because EventSource cannot carry a header.
  //
  // HELD FOR A REAL THIRTY SECONDS, and the number is reported rather than assumed. An earlier shape
  // broke out of the loop as soon as it had one frame and still called that "held for 30 s", which is
  // the shape of a gate measuring its own optimism: what this leg exists to prove is that a
  // cross-origin bearer stream STAYS open, and a stream that is closed by a proxy at twenty seconds
  // would have passed. The abort is on a timer so a stream that goes quiet cannot hang the loop past
  // its window either.
  let frames = 0;
  let eventsStatus = 0;
  let heldMs = 0;
  const controller = new AbortController();
  const HOLD_MS = 30000;
  const startedAt = Date.now();
  const stop = setTimeout(() => controller.abort(), HOLD_MS);
  try {
    const stream = await fetch(relay + "/events", { headers: auth, signal: controller.signal });
    eventsStatus = stream.status;
    if (stream.ok && stream.body) {
      const reader = stream.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) frames += 1;
      }
    }
  } catch (error) {
    // An AbortError at the end of the window is the SUCCESS path: it is this leg closing a stream that
    // was still open. Anything else is the stream dying early and is reported as such.
    if (String(error && error.name) !== "AbortError") say("events died early: " + String(error && error.message));
  }
  clearTimeout(stop);
  controller.abort();
  heldMs = Date.now() - startedAt;
  say("events " + eventsStatus + ", " + frames + " frame(s), held " + heldMs + "ms");

  // An avatar, fetched with the bearer and turned into a blob URL, which is the only way a bundled page
  // can show one: an <img src> carries no header and Chrome's ORB blocks the JSON 401 it would get.
  let avatar = null;
  if (list.length > 0) {
    const res = await fetch(relay + "/avatars/" + (list[0].id ?? list[0].agentId) + ".png", { headers: auth });
    avatar = { status: res.status, blob: res.ok ? URL.createObjectURL(await res.blob()).startsWith("blob:") : false };
  }

  return { ok: true, log, device: minted.device.id, token: minted.token, roster: list.length, outline, digest, eventsStatus, frames, heldMs, avatar };
};
window.__revoke = async (relay, token, device) => {
  const gone = await fetch(relay + "/auth/devices/" + device, { method: "DELETE", headers: { authorization: "Bearer " + token } });
  return { status: gone.status };
};
window.__after = async (relay, token) => {
  const res = await fetch(relay + "/api/listAgents", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" });
  return { status: res.status, relayAuth: res.headers.get("x-relay-auth"), redirected: res.redirected, type: res.type };
};
</script></body>`;

async function legApp(password) {
  // THE ORDER MATTERS AND IS THE POINT. The shell's origin is minted first and then NAMED in the relay's
  // own allow-list, because that is exactly how the desktop shell's origin will be configured on the
  // R750: one SAND_UI_APP_ORIGINS line, no code. A browser cannot present capacitor://localhost, so this
  // leg proves the mechanism on an origin a browser CAN present, and the cors leg above proves the two
  // Capacitor strings with a plain HTTP client.
  const shell = await startShellOrigin(SHELL_PAGE);
  const relay = await startRelay({ extraEnv: { SAND_UI_APP_ORIGINS: shell.origin } });
  const relayOrigin = relay.origin;
  // And the proof that it is the ALLOW-LIST doing the work rather than something permissive: a second
  // origin nobody named is refused by the same relay, in the same browser, one line below.
  const stranger = await startShellOrigin(SHELL_PAGE);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const refusals = [];
  page.on("requestfailed", (request) => refusals.push(`${request.url().replace(relayOrigin, "")} ${request.failure()?.errorText ?? ""}`));
  try {
    await page.goto(shell.origin, { waitUntil: "load", timeout: within(20_000) });
    info(`the shell page is on ${shell.origin}, the relay on ${relayOrigin}: a real second origin, named in SAND_UI_APP_ORIGINS, and Chrome's web security is ON`);

    const out = await page.evaluate(([relay, pass]) => window.__shell(relay, pass).catch((error) => ({ ok: false, why: String(error?.message ?? error), log: [] })), [relayOrigin, password]);
    if (!out.ok) {
      // A 502 is the relay saying the GATEWAY did not answer, which is a box mid-restart and not a
      // product fault: waves D and V recreate this box, and it was measured happening under this very
      // gate on 2026-09-09. Said as a skip with the reason rather than a fail that sends somebody
      // looking at the token door, and never as a pass.
      if (/\b502\b/.test(String(out.why))) {
        skip("a page on a second origin signs in and reads the console's API",
          `the relay answered 502, which is the box's gateway not answering rather than the door: ${out.why}. Re-run when the box is up.`);
        return;
      }
      check(false, "a page on a second origin signs in and reads the console's API", `${out.why}; ${refusals.slice(0, 3).join(" | ")}`);
      return;
    }
    check(true, "a page on a second origin mints a device bearer", `device ${out.device}, token ${String(out.token).slice(0, 5)}… (${String(out.token).length} chars, never printed and never in a URL)`);
    check(out.roster > 0, "and reads the roster across origins", `${out.roster} bot(s)`);
    if (out.outline == null) skip("and reads a conversation", "the box has no bots, so there is no conversation to read");
    else {
      check(out.outline.status === 200, `and reads a named conversation ("${out.outline.name}") across origins`,
        `HTTP ${out.outline.status}, ${out.outline.bytes} decoded bytes`
        + (out.outline.items != null ? `, ${out.outline.items} outline items` : "")
        + (out.outline.body ? ` — ${out.outline.body}` : ""));
    }
    if (out.digest == null) skip("and the unchanged-answer protocol works across origins", "the box has no conversation to read twice");
    else {
      check(out.digest.readable, "a cross-origin page can READ x-titan-digest off an /api answer",
        out.digest.readable
          ? `${out.digest.head}…, and the headers this page can see are: ${out.digest.visible}`
          : `headers.get("x-titan-digest") answered null; the page can only see: ${out.digest.visible}. The relay's access-control-expose-headers is the thing to fix, not the page`);
      check(out.digest.unchanged && out.digest.second <= 64,
        "and sending it back costs 20 bytes instead of the whole answer",
        `${out.digest.first} bytes, then ${out.digest.second} bytes${out.digest.unchanged ? " ({\"__unchanged\":true})" : ""} — this is the mechanism the 100 KiB idle ceiling rests on, and it was dead on a bundled origin until 2026-09-10`);
    }
    check(out.eventsStatus === 200, "and holds /events open with fetch plus a stream reader", `HTTP ${out.eventsStatus} (EventSource carries no header, which is why it is not used)`);
    check(out.heldMs >= 29_000, "and the stream is still open thirty seconds later", `held ${out.heldMs} ms before this gate closed it`);
    check(out.frames >= 1, "and counts at least one frame on it", `${out.frames}`);
    if (out.avatar == null) skip("and turns an avatar into a blob URL", "no bots");
    else check(out.avatar.status === 200 ? out.avatar.blob : out.avatar.status === 404,
      "and fetches an avatar with the bearer rather than a bare <img>", `HTTP ${out.avatar.status}, blob ${out.avatar.blob}`);

    const gone = await page.evaluate(([relay, token, device]) => window.__revoke(relay, token, device), [relayOrigin, out.token, out.device]);
    check(gone.status === 200, "the device revokes itself from that page", `HTTP ${gone.status}`);
    // DEVICE_CACHE_MS is 2 s; a little over it is the bound this gate measures rather than asserts.
    await sleep(2600);
    const after = await page.evaluate(([relay, token]) => window.__after(relay, token), [relayOrigin, out.token]);
    check(after.status === 401, "and the next call is 401 within the cache window", `HTTP ${after.status} after 2.6 s`);
    check(after.relayAuth === "required", "carrying x-relay-auth: required, which is what a shell branches on", String(after.relayAuth));
    check(after.redirected === false, "and never a redirect into the login page", `redirected ${after.redirected}, type ${after.type}`);

    // The allow-list is what made all of that possible, and nothing else: the same relay, the same
    // browser, an origin nobody named. A "Failed to fetch" here is the browser refusing on our 403,
    // which is the shape a third-party page meets.
    const outsider = await context.newPage();
    await outsider.goto(stranger.origin, { waitUntil: "load", timeout: within(20_000) });
    const blocked = await outsider.evaluate(([relay, pass]) =>
      window.__shell(relay, pass).then((out) => ({ reached: out.ok === true })).catch((error) => ({ reached: false, why: String(error?.message ?? error) })),
    [relayOrigin, password]);
    check(blocked.reached === false, "an origin nobody named cannot call the relay from a page at all",
      `${stranger.origin}: ${blocked.why ?? "it got through, which means the allow-list is not doing the work"}`);
    await outsider.close();
  } finally {
    await context.close();
    await shell.stop();
    await stranger.stop();
  }
}

// ---- run --------------------------------------------------------------------------------------

let release = () => {};
try {
  if (URL_TARGET == null) {
    release = await acquireBoxLock({ what: "verify-door.mjs", log: (line) => info(line) });
    // Only now does the 300 s ceiling mean anything: see the comment on startBudget.
    startBudget();
  }
  browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });

  if (chosen.includes("door")) {
    // Both branches of the one template. The page is rendered without ever calling the control plane,
    // so a CP_URL nothing answers at is the right way to draw the second one.
    for (const tenant of [false, true]) {
      const origin = URL_TARGET ?? (await startRelay({ tenant })).origin;
      step(`the front door at ${origin}${tenant ? ", with a control plane behind it" : ""}`);
      for (const phone of PHONES) await legDoor(origin, phone, { tenant: URL_TARGET != null ? undefined : tenant });
      if (URL_TARGET != null) break;
    }
  }

  if (chosen.includes("cors")) {
    const relay = URL_TARGET ?? (await startRelay({ tenant: false })).origin;
    step(`CORS at ${relay}`);
    await legCors(relay);
  }

  if (chosen.includes("app")) {
    if (URL_TARGET != null) {
      skip("a page on a second origin against the live console", "the live legs run from the R750 run, with a throwaway account");
    } else {
      step("a bundled shell: a page on a second origin, against a relay from this worktree");
      await legApp(GATE_PASSWORD);
    }
  }

  if (chosen.includes("mobile")) {
    step("scripts/verify-mobile.mjs --width, as a regression on the corrected rule");
    if (budgetLeft() < 90_000) skip("the width regression", `only ${Math.round(budgetLeft() / 1000)}s of budget left; run it on its own`);
    else {
      const child = spawn(process.execPath, ["scripts/verify-mobile.mjs", "--width"], { cwd: repoRoot, env: { ...process.env, BOX_LOCK_DIR: "/tmp/titanbot-box-door-inner.lock" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, within(100_000));
        child.on("exit", (status) => { clearTimeout(timer); resolve(status); });
      });
      for (const line of out.split("\n").filter((one) => /PASS|FAIL|INFO/.test(one))) console.log(`  ${line.trim()}`);
      if (code == null) skip("the width regression", "it did not finish inside its slice of the budget");
      else check(code === 0, "the console's own width legs are green with the corrected rule", `exit ${code}`);
    }
  }

  check(pageErrors.length === 0, "no page threw at any size", pageErrors.slice(0, 3).join(" | "));
} catch (error) {
  check(false, "the gate ran to the end", String(error?.stack ?? error));
} finally {
  if (browser != null) await browser.close().catch(() => {});
  for (const relay of relays) relay.stop();
  release();
}

console.log("");
console.log(`measured on ${process.env.GROK_BOT_MACHINE ?? "grok-bot-local-vm (this Mac)"} at 390x844 and 430x932, device scale 3, touch, iPhone UA, real Chrome through playwright-core`);
console.log("Chrome cannot raise an iPhone's zoom: visualViewport.scale stays 1 through focus at both widths. The door's evidence is the computed font-size on every control plus the absent autofocus attribute.");
console.log(`${passes} PASS / ${failures} FAIL / ${skips} SKIP`);
process.exit(failures === 0 ? 0 : 1);
