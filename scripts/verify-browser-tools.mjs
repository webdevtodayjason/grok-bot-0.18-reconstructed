#!/usr/bin/env node
// verify-browser-tools.mjs -- BROWSER-1. Titan's own browser, measured on the box.
//
// Titan could not open a web page. Chrome has been running in every box the whole time, on the
// person's own profile, visible in the console's desktop view -- but the fifteen browser tools
// were withheld from the main agent by one predicate in turn-toolset.ts, and the subagent that
// could reach them sat behind a gate that is off. So "read this page for me" got prose.
//
// BROWSER-1 hands four of them to Titan directly: browser_open, browser_click, browser_type,
// browser_screenshot, behind the box setting SAND_BROWSER_TOOLS, which defaults ON. This gate is
// the proof, and it measures the whole chain rather than any one link:
//
//   1. the four tools are in the CHIEF's own toolset line, not a subagent's
//   2. they leave for the provider (the [sand][wire] line carries them, sent == offered)
//   3. the system prompt tells the model when to use them and how to hand a login back
//   4. a real page comes back as words: example.com, and a YouTube channel title
//   5. a login-walled page says so in plain words, with needsLogin set
//   6. a challenge page says so, with blocked set -- both the one that serves a body and the bare
//      refusal that serves none, which is the one a real site sends
//   7. typing and clicking change a page this gate serves itself
//   8. every result is text plus exactly ONE image part, a JPEG 1280 wide
//   9. the audit ledger gained one browser_navigation row per open, with url and title
//  10. the desktop view still shows the SAME Chrome: no new profile, no doubled window count
//  11. with SAND_BROWSER_TOOLS off the four are withheld and the line says why
//  12. an address that is not on the public web is refused: a local file, and this box's own
//      loopback. Without that check a page can talk the model into reading the box's files and
//      the services beside it, and both come back as page text plus a picture.
//
// HOW IT DRIVES. Not a real model. A stub OpenAI-compatible server on this Mac answers with a
// scripted sequence of browser tool calls (the pattern in scripts/verify-loop.mjs and
// scripts/verify-onboarding.mjs), so the same eight actions run in the same order every time and
// a failure is the product's, never the model's mood. The stub is also the measurement surface:
// the host hands every tool result back in the next request, so the stub reads the exact text and
// the exact image parts the model was given. Nothing else in this repo can see that.
//
// The two fixtures -- a form page and a login wall -- are served by this script on
// host.docker.internal, which is how the box reaches this Mac (proved before anything is pinned).
//
// Nothing here is permanent. The endpoint pin, SAND_TOOL_TRACE, SAND_BROWSER_TOOLS and the
// scratch agent are all restored in a finally, whatever happened.
//
//   SAND_PROFILE_DIRS=/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data \
//     node scripts/verify-browser-tools.mjs
//
//   --offline        skip example.com and the YouTube channel; the two fixtures still run
//   --keep           leave the scratch agent behind
//   --port <n>       the fixture server's port (default 18791)
//   --stub-port <n>  the stub model's port (default 18792)
//   --timeout-ms <n> the turn's patience (default 420000)
//   --no-off-leg     skip leg 11 (a second turn with the setting off)
//   --cloud-shape    CLOUD-BROWSER-1: run every page through the CLOUD path against this box's own
//                    browser, so the shape claim is measured without a vendor and without a bill
//   --cloud-live     CLOUD-BROWSER-1, METERED: one short session per vendor, minutes and proxy
//                    bytes recorded, each one read back from the vendor to prove it stopped
//   --vendors-only   run ONLY the metered arm: no box, no stub, no endpoint pin. Pair with
//                    --cloud-live to check the vendors without a six-minute box run
//
// Run it on its own. It repins the box's model endpoint for the length of the run, so a second
// gate running beside it would be answered by this stub.
//
// Exit 0 nothing failed, 1 something failed, 2 nothing could be measured.
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const AGENTS_DIR = "/home/box/sand-data/agents";
const HOST_LOG = "/tmp/sand-host.log";

const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const OFFLINE = process.argv.includes("--offline");
const KEEP = process.argv.includes("--keep");
const SKIP_OFF_LEG = process.argv.includes("--no-off-leg");
// The dry run touches neither the box nor the gateway, so it must not need the gateway's token
// either. Reading the token here and exiting 2 without one is how a dry run stops being runnable
// on the machine it exists to be runnable on.
const DRY_RUN = process.argv.includes("--dry-run");
/**
 * CLOUD-BROWSER-1, two arms.
 *
 * --cloud-shape  routes the four tools through the CLOUD PATH -- the request file, the
 *                attach-by-URL, the same page reader -- against the box's OWN Chrome debugger, by
 *                setting SAND_CLOUD_BROWSER_LOOPBACK_CDP. Nothing is minted at a vendor and nothing
 *                is spent, and the claim that matters is proved on a real box: a page read through
 *                the cloud path comes back in the same shape as a page read through the box path.
 *                It also greps every argument list in the box afterwards, which is the MARKET-17
 *                check: no vendor host, no key and no session id may be in any process's argv.
 *
 * --cloud-live   one short session per vendor against the real API, minutes and proxy bytes
 *                recorded, and each session's state read back from the vendor to prove it stopped.
 *                Metered. One run per vendor, no loops, and no retry without reading the state
 *                first. Skipped with a printed reason when no key is stored.
 */
const CLOUD_SHAPE = process.argv.includes("--cloud-shape");
const CLOUD_LIVE = process.argv.includes("--cloud-live");
/**
 * --vendors-only runs the metered arm and nothing else.
 *
 * That arm measures the VENDOR -- what a session costs, what it reports, whether the stop works --
 * not the product, so it needs no box, no stub and no endpoint pin. Making it wait behind a
 * six-minute box run that also repins the box's model would mean nobody checks the vendors between
 * releases, which is the whole point of having the arm.
 */
const VENDORS_ONLY = process.argv.includes("--vendors-only");
const CLOUD_CDP_SETTING = "SAND_CLOUD_BROWSER_LOOPBACK_CDP";
// How long a held browser may sit unused before the host gives it back. Shortened here on purpose:
// the product's own default is four minutes, which is longer than this gate is allowed to take.
// Not shortened FURTHER on purpose either -- at eight seconds the gaps between one turn's own tool
// calls exceeded it, the browser was given back between the type and the click, and the gate
// recreated the very defect it exists to catch ("nothing on the page matched Save note", measured
// here 2026-09-09). Forty-five is comfortably longer than a turn's own gaps and short enough to
// wait out.
const CLOUD_IDLE_SETTING = "SAND_CLOUD_BROWSER_IDLE_SECONDS";
const CLOUD_IDLE_SECONDS = 45;
const CLOUD_ENGINES_FILE = "/home/box/sand-data/browser-engines.json";
const CLOUD_LEDGER_FILE = "/home/box/sand-data/cloud-browser-ledger.jsonl";
const FIXTURE_PORT = Number.parseInt(flag("--port", "18791"), 10);
const STUB_PORT = Number.parseInt(flag("--stub-port", "18792"), 10);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "420000"), 10);
const STUB_ID = "probe-browser-tools";
const STUB_MODEL = "probe-browser-tools-model";
// The four Titan gets. The other eleven stay with the browserUse subagent.
const TITAN_BROWSER_TOOLS = ["browser_open", "browser_click", "browser_type", "browser_screenshot"];
const BROWSER_TOOLS_SETTING = "SAND_BROWSER_TOOLS";
// The operator's list of names the browser may open even though they are not on the public web.
// This gate's fixtures live on this Mac, which the box reaches as host.docker.internal -- a docker
// host address, and therefore refused like any other private address unless it is on this list.
const ALLOW_HOSTS_SETTING = "SAND_BROWSER_ALLOW_HOSTS";
// The contract's screenshot: one JPEG, resized to 1280 wide, per action.
const SHOT_WIDTH = 1280;
const SHOT_MIME = "image/jpeg";
// Readable main text is capped here so a long page cannot eat a turn's context.
const TEXT_CAP = 40_000;

let failures = 0;
let unmeasured = 0;
let nothingToMeasure = "";
// Thrown rather than exited. `process.exit` skips finally blocks, and the finally below is what
// puts the operator's endpoint pin and two settings back -- so an early exit for "the box is not
// answering" would leave the box pointed at a stub that is no longer listening.
class NothingToMeasure extends Error {}
// --vendors-only. Not a failure and not "nothing could be measured": the box run was deliberately
// skipped, and the metered arm after the finally is the run.
class SkipTheBoxRun extends Error {}
const bail = (why) => { throw new NothingToMeasure(why); };
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); unmeasured += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (name) => console.log(`\n== ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text, width = 160) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, width);

// ---------------------------------------------------------------- the box and the gateway
function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

let TOKEN;
try { TOKEN = token(); } catch (error) {
  if (!DRY_RUN) {
    console.error(`nothing could be measured: ${error.message}`);
    process.exit(2);
  }
  TOKEN = "";
}

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
  const res = await fetch(`${GATEWAY}${route}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${typeof parsed === "string" ? parsed.slice(0, 200) : parsed.error ?? ""}`);
  return parsed;
};

const docker = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 64 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const sh = (script) => docker(["exec", BOX, "sh", "-lc", script]);

// The switch file, not container env: both settings below have to move on a running box.
const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try { return JSON.parse(raw)[name]; } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null
    ? `delete d[${JSON.stringify(name)}];`
    : `d[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

const hostLogLines = async () =>
  Number.parseInt((await sh(`wc -l < ${HOST_LOG}`)).trim(), 10) || 0;

const jsonLinesSince = async (from, marker) => {
  const out = await sh(`tail -n +${from + 1} ${HOST_LOG} | grep -F '${marker} ' || true`);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf(`${marker} `);
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + marker.length + 1))]; } catch { return []; }
  });
};
const toolsetLinesSince = (from) => jsonLinesSince(from, "[sand][toolset]");
const wireLinesSince = (from) => jsonLinesSince(from, "[sand][wire]");

// ---------------------------------------------------------------- the desktop, before and after
//
// The failure this exists to catch is the one ui/server.mjs already carries a comment about: a
// second Chrome, on a different profile with no debug port, so "the operator watched one browser
// while the agent tried to drive another". Two facts settle it. The set of profiles with a running
// Chrome must not grow, and no display's window count may double.
const CHROME_INVENTORY = `
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  c=$(tr '\\0' '\\n' < "$p/cmdline" 2>/dev/null | head -1)
  case "$c" in *chrome*|*chromium*) ;; *) continue ;; esac
  d=$(tr '\\0' '\\n' < "$p/cmdline" 2>/dev/null | grep -m1 '^--user-data-dir=' | cut -d= -f2-)
  [ -n "$d" ] && echo "profile $d"
done | sort -u
for x in /tmp/.X11-unix/X*; do
  [ -e "$x" ] || continue
  n=$(basename "$x" | sed 's/^X//')
  w=$(DISPLAY=:$n xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //' | tr ',' '\\n' | grep -c '0x' || true)
  echo "windows :$n \${w:-0}"
done
`;
const chromeInventory = async () => {
  // Passed with its newlines intact: flattening a `for ... do ... done` onto one line without
  // semicolons is a syntax error the shell reports as nothing at all.
  const out = await sh(CHROME_INVENTORY);
  const profiles = new Set();
  const windows = new Map();
  for (const line of out.split("\n")) {
    const profile = /^profile (.+)$/.exec(line.trim());
    if (profile) { profiles.add(profile[1]); continue; }
    const window = /^windows (:\d+) (\d+)$/.exec(line.trim());
    if (window) windows.set(window[1], Number(window[2]));
  }
  return { profiles, windows };
};

// ---------------------------------------------------------------- CLOUD-BROWSER-1, the readers
//
// MARKET-17/MARKET-24 as one grep. A cloud debugger endpoint carries the session's own credential,
// and argv is readable from any process in the box -- the agent's own shell included. So after a
// cloud run this walks every process's argument list and fails on anything that looks like a vendor
// host, a vendor key or a session id. The patterns are deliberately broader than what this product
// writes: the check is worth having only if it would catch a shape nobody planned.
const CLOUD_ARGV_OFFENDERS = [
  /\bwss:\/\//i,
  /browser-use\.com/i,
  /browserbase\.com/i,
  /\bbu_[A-Za-z0-9_-]{8,}/,
  /\bbb_(live|test)_[A-Za-z0-9_-]{6,}/,
  /X-Browser-Use-API-Key/i,
  /X-BB-API-Key/i,
];
export function cloudArgvOffenders(text) {
  const offenders = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // The gate's own loopback endpoint is a ws:// on 127.0.0.1 and is not a secret; only wss:// and
    // the vendor shapes above are offences.
    if (CLOUD_ARGV_OFFENDERS.some((pattern) => pattern.test(trimmed))) offenders.push(trimmed.slice(0, 160));
  }
  return offenders;
}

/**
 * WHICH ENGINE ACTUALLY RAN, read from the ledger rather than guessed at.
 *
 * The driver stamps `engine` on its own result line, but the host never puts that in the text the
 * model is handed -- and the model's text is all this stub can see. So the evidence is the thing
 * the product writes anyway: one row per cloud session in
 * /home/box/sand-data/cloud-browser-ledger.jsonl. No row means no cloud session, which is what
 * makes the desktop-invariant leg below unable to pass vacuously: it asserts the browser did not
 * double AND that a cloud session is on record, so "nothing ran at all" fails instead of passing.
 *
 * Two lines per session fold into one row, last write winning, exactly as the host's own reader
 * folds them.
 */
/**
 * Write a file inside the box without putting its content through a shell.
 *
 * The payload is base64 on the command line and decoded in the box, so an apostrophe, a newline or
 * a dollar sign in a JSON document cannot turn the rest of the command into something else. Nested
 * quoting through `docker exec sh -lc` is a trap this repo has been bitten by more than once, and
 * it fails quietly, which is the worst way for a gate's setup to fail.
 */
const writeBoxFileB64 = (boxPath, content) =>
  sh(`printf '%s' '${Buffer.from(String(content), "utf8").toString("base64")}' | base64 -d > ${boxPath} && chmod 600 ${boxPath}`);

/**
 * The two keys the metered leg needs, by EXACT NAME, out of ~/.api_keys. Nothing else is read from
 * that file and no value is ever printed: the leg prints minutes, bytes and HTTP statuses.
 */
async function readApiKeys() {
  const wanted = ["BROWSER_USE_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"];
  const found = {};
  try {
    const text = readFileSync(`${process.env.HOME}/.api_keys`, "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\n#]+)["']?\s*$/.exec(line);
      if (match != null && wanted.includes(match[1])) found[match[1]] = match[2].trim();
    }
  } catch {
    // No file, or unreadable. The legs above skip with a printed reason.
  }
  return found;
}

/** One vendor request, with a hard deadline and its body parsed. Never retried by this helper. */
async function vendorCall(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: String(error?.message ?? error).slice(0, 160) } };
  }
}

export function parseCloudLedger(text) {
  const bySession = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (row == null || typeof row.sessionId !== "string" || row.sessionId.length === 0) continue;
    bySession.set(row.sessionId, row);
  }
  return [...bySession.values()];
}

// ---------------------------------------------------------------- reading a JPEG's width
//
// "one jpeg, resized to 1280 wide" is a claim about bytes, so it is read out of the bytes. Walk
// the segment markers to the start-of-frame and take the two shorts in its payload.
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // Every SOFn but the four that are not frames (0xc4 DHT, 0xc8, 0xcc DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 >= bytes.length) return null;
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------- the fixtures this gate serves
//
// Two pages and a challenge, so the click, the type, the login hand-off and the blocked flag are
// measured against something this script controls rather than whatever the open web did today.
const FIXTURE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Titan browser gate</title></head>
<body>
<nav id="chrome-junk">Home Products Pricing Careers Legal Cookie settings Subscribe to our newsletter</nav>
<script>var noise = "SCRIPTNOISE must never reach the model";</script>
<style>.hidden { display: none } /* STYLENOISE must never reach the model */</style>
<main>
  <h1>Titan browser gate</h1>
  <p>The quarterly service report is ready. Anvil Mail delivered nine hundred and twelve messages
  last week with no bounces, and every client on the mesh reported in.</p>
  <form id="note-form" onsubmit="return false">
    <label for="note">Note</label>
    <input id="note" name="note" type="text" value="">
    <button id="save" type="button">Save note</button>
  </form>
  <div id="result"></div>
</main>
<script>
document.getElementById("save").addEventListener("click", function () {
  document.getElementById("result").textContent = "note saved: " + document.getElementById("note").value;
});
</script>
</body></html>`;

const FIXTURE_LOGIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in — Titan browser gate</title></head>
<body><main>
  <h1>Sign in to continue</h1>
  <form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="password">Password</label><input id="password" name="password" type="password" required>
    <button type="submit">Sign in</button>
  </form>
  <p>You need an account to read this page.</p>
</main></body></html>`;

const FIXTURE_BLOCKED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Access Denied</title></head>
<body><h1>Access Denied</h1>
<p>You do not have permission to access this resource.</p></body></html>`;

// The two words the extractor must never carry through, and the phrase it must.
const PAGE_PROSE = "Anvil Mail delivered nine hundred and twelve messages";
const NOTE_TEXT = "titan was here";

function startFixtures(port) {
  const server = http.createServer((req, res) => {
    const path = String(req.url ?? "/").split("?")[0];
    const send = (status, body, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (path === "/login") return send(200, FIXTURE_LOGIN);
    if (path === "/blocked") return send(403, FIXTURE_BLOCKED);
    // A refusal with NOTHING to render, which is what a real site sends. Chrome shows its own
    // error page for this and reports the navigation as failed, so the page reader never sees it
    // and the block detector never runs -- unless the driver treats that failure as a refusal.
    // The leg above measures the case that already worked; this one measures the case that did not.
    if (path === "/refused") return send(403, "");
    if (path === "/health") return send(200, "ok", "text/plain; charset=utf-8");
    return send(200, FIXTURE_PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

// ---------------------------------------------------------------- the stub model
//
// It answers only requests that offer browser_open: a summarizer or a title generator borrowing
// the same pinned endpoint gets plain text so its turn settles and the plan below is not consumed
// by a call that was never under test.
//
// The plan is fixed and ordered. `argsFor` reads the offered schema and picks the argument name
// the host is actually advertising, so a rename in the tool definition shows up as a named
// mismatch here rather than as fifteen failures downstream.
function startStub(port, plan, state) {
  const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta, finish = null) => ({
    id: "probe-browser-tools", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: STUB_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  // Walk the history and rebuild what the host handed back. A tool result is one message; the
  // image parts that came with it arrive as the user message immediately after it, so they belong
  // to the tool result they follow.
  const readResults = (messages) => {
    // Which tool each call id belongs to, taken from the assistant messages that made the calls.
    // The tool message's own `name` field is optional in the OpenAI shape and the host does not
    // send it, so counting on it made this stub replay step one forever: measured on
    // grok-bot-local-vm 2026-09-07, browser_open on example.com succeeded and was dispatched
    // again 100 times, because zero results were ever counted. The call id is the thing both
    // sides always agree on.
    const toolOfCallId = new Map();
    for (const message of messages ?? []) {
      for (const call of message?.tool_calls ?? []) {
        const name = call?.function?.name ?? call?.name;
        if (call?.id != null && name != null) toolOfCallId.set(String(call.id), String(name));
      }
    }
    const seen = [];
    for (const message of messages ?? []) {
      if (message?.role === "tool") {
        let parsed = null;
        try { parsed = JSON.parse(String(message.content ?? "")); } catch {}
        const callId = String(message.tool_call_id ?? "");
        // Third way to learn which tool answered: the wrapper the host puts round every tool
        // result names it. `source="browser_open"`.
        const fromWrapper = String(message.content ?? "").match(/<cursor_untrusted_data_\d+[^>]*\bsource="([^"]+)"/)?.[1];
        seen.push({
          name: String(message.name ?? toolOfCallId.get(callId) ?? fromWrapper ?? ""),
          callId,
          raw: String(message.content ?? ""),
          parsed,
          followingImages: 0,
          images: [],
        });
        continue;
      }
      if (message?.role === "user" && Array.isArray(message.content) && seen.length > 0) {
        // The bytes, not just the count. This host sends a tool's screenshot as the user message
        // right after the tool result, as a data: URL, and the mime type and the JPEG itself can
        // only be checked from the URL. Counting them and asserting on a placeholder is how this
        // gate reported "0 bytes, no start-of-frame marker" about seven real JPEGs.
        for (const part of message.content) {
          if (part?.type !== "image_url") continue;
          const url = String(part.image_url?.url ?? "");
          const match = url.match(/^data:([^;,]+);base64,(.*)$/);
          seen.at(-1).followingImages += 1;
          seen.at(-1).images.push(match == null
            ? { type: "image", mimeType: "", data: "" }
            : { type: "image", mimeType: match[1], data: match[2] });
        }
      }
    }
    return seen;
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        object: "list",
        data: [{ id: STUB_MODEL, object: "model", max_model_len: 128_000, context_length: 128_000 }],
      }));
    }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
      const offered = (parsed.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);
      state.requests += 1;

      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
      });
      const plain = (line) => {
        sse(res, chunk({ role: "assistant", content: line }));
        sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (!offered.includes("browser_open")) return plain("done");

      // Only now: this is the turn under test. Reading the prompt off whichever request arrived
      // first would read a title generator's, which is a different and much shorter prompt.
      const system = (parsed.messages ?? []).filter((m) => m?.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
      if (state.systemPrompt === "" && system.length > 0) state.systemPrompt = system;
      if (state.offered.length === 0) state.offered = offered;

      // BROWSER_GATE_DUMP=<file> writes every request the host sent here, one JSON per line. The
      // shape of a tool result on the wire is the one thing this gate cannot guess right, and
      // guessing it wrong makes the gate report "no text" about a tool that answered perfectly.
      if (process.env.BROWSER_GATE_DUMP) {
        try { appendFileSync(process.env.BROWSER_GATE_DUMP, `${JSON.stringify(parsed.messages ?? [])}\n`); } catch {}
      }
      state.results = readResults(parsed.messages);
      const at = state.results.filter((r) => r.name.startsWith("browser_")).length;
      const next = plan[at];
      if (next == null) return plain("I read the pages and the note saved.");

      const schema = (parsed.tools ?? [])
        .find((t) => (t?.function?.name ?? t?.name) === next.tool)?.function?.parameters
        ?? (parsed.tools ?? []).find((t) => t?.name === next.tool)?.parameters;
      const properties = Object.keys(schema?.properties ?? {});
      // The argument this gate means, under whatever name the tool advertises for it.
      const argsFor = (wanted) => {
        const out = {};
        for (const [role, value] of Object.entries(wanted)) {
          const name = [role, ...(ARG_ALIASES[role] ?? [])].find((candidate) => properties.includes(candidate))
            ?? role;
          if (!properties.includes(name)) state.unknownArgs.push(`${next.tool}.${role}`);
          out[name] = value;
        }
        return out;
      };
      if (!offered.includes(next.tool)) {
        state.missingTools.push(next.tool);
        return plain(`the tool ${next.tool} was not offered`);
      }
      state.dispatched.push(next.label);
      const args = JSON.stringify(argsFor(next.args));
      sse(res, chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_browser_${at + 1}`, type: "function", function: { name: next.tool, arguments: args } }],
      }));
      sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

// Names this gate will accept for each argument it means. The first that the tool advertises wins.
const ARG_ALIASES = {
  url: ["href", "address"],
  target: ["selector", "element", "ref", "text"],
  text: ["value", "content"],
  submit: ["pressEnter", "enter"],
};

// ---------------------------------------------------------------- the run
const FIXTURE_BASE = `http://host.docker.internal:${FIXTURE_PORT}`;
const PLAN = [
  ...(OFFLINE ? [] : [
    { label: "example.com", tool: "browser_open", args: { url: "https://example.com" } },
    { label: "the YouTube channel", tool: "browser_open", args: { url: "https://www.youtube.com/@TitaniumComputing" } },
  ]),
  { label: "the login wall", tool: "browser_open", args: { url: `${FIXTURE_BASE}/login` } },
  { label: "the challenge page", tool: "browser_open", args: { url: `${FIXTURE_BASE}/blocked` } },
  { label: "the bare refusal", tool: "browser_open", args: { url: `${FIXTURE_BASE}/refused` } },
  { label: "the test page", tool: "browser_open", args: { url: `${FIXTURE_BASE}/` } },
  { label: "typing the note", tool: "browser_type", args: { target: "#note", text: NOTE_TEXT, submit: false } },
  { label: "clicking Save note", tool: "browser_click", args: { target: "Save note" } },
  { label: "a screenshot", tool: "browser_screenshot", args: {} },
  // The two the browser must refuse. `refuses` marks them: they never reach the box, so they come
  // back as words with no picture and leave no row in the ledger.
  { label: "a local file", tool: "browser_open", args: { url: "file:///etc/passwd" }, refuses: true },
  { label: "this box's own loopback", tool: "browser_open", args: { url: "http://127.0.0.1:7777/" }, refuses: true },
];

const stubState = {
  requests: 0, systemPrompt: "", offered: [], results: [],
  dispatched: [], missingTools: [], unknownArgs: [],
};

let fixtures = null;
let stub = null;
let agentId = null;
let previousEndpoint = null;
let endpointsTouched = false;
let previousTrace;
let previousBrowserSetting;
let previousAllowHosts;
let settingsTouched = false;
// CLOUD-BROWSER-1. Restored in the finally like everything else this gate touches: a run that dies
// must not leave a box pinned to a cloud engine.
let previousCloudCdp;
let previousCloudIdle;
let previousEngines = "";
let cloudTouched = false;
let cloudLedgerBefore = 0;

// The plan runs in order and each step produces one result, so position identifies it -- but only
// while nothing went missing. The tool name is checked too, so a step the host never ran shifts
// everything after it into a named mismatch rather than into results belonging to another page.
const resultsFor = (label) => {
  const at = PLAN.findIndex((entry) => entry.label === label);
  if (at < 0) return null;
  const result = stubState.results.filter((r) => r.name.startsWith("browser_"))[at] ?? null;
  return result != null && result.name === PLAN[at].tool ? result : null;
};
// The text the model was shown.
//
// Measured on grok-bot-local-vm 2026-09-07, a tool result arrives on the wire as a PLAIN STRING
// wrapped in an untrusted-data tag, not as a JSON envelope of typed parts:
//
//   { role: "tool", tool_call_id: "call_browser_1", content:
//     "<cursor_untrusted_data_1337 source=\"browser_open\">Opened the page...</cursor_untrusted_data_1337>" }
//
// Reading it as `parsed.content[]` found nothing and reported NO TEXT about tools that had
// answered perfectly. Both shapes are read here, because the string is what this host sends and
// the parts array is what the OpenAI shape allows.
const UNTRUSTED_WRAPPER = /^\s*<cursor_untrusted_data_\d+[^>]*>\n?([\s\S]*?)\n?<\/cursor_untrusted_data_\d+>\s*$/;
const textOf = (result) => {
  const parts = result?.parsed?.content;
  if (Array.isArray(parts)) {
    const joined = parts.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n");
    if (joined.length > 0) return joined;
  }
  if (typeof result?.parsed?.text === "string") return result.parsed.text;
  const raw = String(result?.raw ?? "");
  return raw.match(UNTRUSTED_WRAPPER)?.[1] ?? raw;
};
// The images the model was shown. This host never puts them in the tool message: it sends them as
// the user message right after it, which is what `followingImages` counts. The parts array is read
// too, for a host that one day does.
const imagesOf = (result) => {
  const parts = result?.parsed?.content;
  const inline = Array.isArray(parts) ? parts.filter((part) => part?.type === "image") : [];
  if (inline.length > 0) return inline;
  return result?.images ?? [];
};

// ---------------------------------------------------------------- --dry-run
//
// Everything above needs a box, a gateway and about seven minutes. This does not, and it exists
// because none of that proves the GATE works: a plan that dispatches out of order, an SSE frame
// the host cannot parse, a result-reader that pairs an image with the wrong page, a JPEG reader
// that returns the height as the width. Each of those makes the real run lie rather than fail.
//
// So the dry run plays the host itself. It stands up the same two servers, drives the stub through
// the whole plan with tool results it composes, and asserts what came back -- then reads its own
// fixtures over HTTP to prove the pages say what the assertions below look for.
if (DRY_RUN) {
  step("dry run: the gate's own machinery, with no box");
  const fixtureServer = await startFixtures(FIXTURE_PORT);
  const dryState = { requests: 0, systemPrompt: "", offered: [], results: [], dispatched: [], missingTools: [], unknownArgs: [] };
  const dryStub = await startStub(STUB_PORT, PLAN, dryState);
  try {
    // A JPEG with nothing in it but a start-of-frame saying 720 by 1280. Enough for jpegSize, and
    // it is the reader that is under test here, not the encoder.
    const fakeJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
    ]);
    const size = jpegSize(fakeJpeg);
    check(size?.width === SHOT_WIDTH && size?.height === 720, "the JPEG reader takes the width from the start-of-frame, not the height",
      size == null ? "no frame found" : `${size.width}x${size.height}`);
    check(jpegSize(Buffer.from("not a jpeg at all")) == null, "and a file that is not a JPEG reads as none");

    // The toolset the host would advertise, in the shape openAiCompatibleTools produces.
    const tools = [
      { type: "function", function: { name: "browser_open", parameters: { type: "object", properties: { url: {} } } } },
      { type: "function", function: { name: "browser_click", parameters: { type: "object", properties: { target: {} } } } },
      { type: "function", function: { name: "browser_type", parameters: { type: "object", properties: { target: {}, text: {}, submit: {} } } } },
      { type: "function", function: { name: "browser_screenshot", parameters: { type: "object", properties: {} } } },
    ];
    const messages = [
      { role: "system", content: "The box desktop. For one page, open it yourself. For a long multi-step job, delegate to a subagent. If a page needs a sign in, say so and let them sign in on the desktop view. Read the web with WebFetch first, then TinyFish, then the browser." },
      { role: "user", content: "Open the pages I asked about." },
    ];
    const askTheStub = async () => {
      const res = await fetch(`http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: STUB_MODEL, tools, messages, stream: true }),
      });
      const body = await res.text();
      const frames = body.split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map((line) => { try { return JSON.parse(line.slice(6)); } catch { return null; } }).filter(Boolean);
      const call = frames.flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? [])[0] ?? null;
      const text = frames.map((frame) => frame.choices?.[0]?.delta?.content ?? "").join("");
      return { call, text };
    };
    let dispatched = 0;
    for (let round = 0; round < PLAN.length + 2; round += 1) {
      const { call, text } = await askTheStub();
      if (call == null) { check(text.length > 0, "the stub closes with plain words once the plan is spent", text || "(silence)"); break; }
      const expected = PLAN[dispatched];
      check(call.function.name === expected.tool, `dry run step ${dispatched + 1}: ${expected.label} is dispatched as ${expected.tool}`,
        `got ${call.function.name}`);
      const args = JSON.parse(call.function.arguments);
      if (expected.args.url != null) {
        check(args.url === expected.args.url, `dry run step ${dispatched + 1}: it carries the address the plan named`, String(args.url));
      }
      dispatched += 1;
      // What the host sends back: the assistant's call, the tool result, and the image beside it.
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] });
      messages.push({
        role: "tool", tool_call_id: call.id, name: call.function.name,
        content: JSON.stringify({
          content: [
            { type: "text", text: `${expected.label}: read it. ${PAGE_PROSE}. note saved: ${NOTE_TEXT}. Sign in to continue.` },
            { type: "image", data: fakeJpeg.toString("base64"), mimeType: SHOT_MIME },
          ],
          isError: false,
        }),
      });
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshot from the tool call above." },
          { type: "image_url", image_url: { url: `data:${SHOT_MIME};base64,${fakeJpeg.toString("base64")}` } },
        ],
      });
    }
    check(dispatched === PLAN.length, "the dry run drove every step of the plan, in order",
      `${dispatched} of ${PLAN.length}: ${dryState.dispatched.join(", ")}`);
    check(dryState.missingTools.length === 0 && dryState.unknownArgs.length === 0,
      "and found every tool and argument name it looks for",
      `${dryState.missingTools.join(", ")} ${dryState.unknownArgs.join(", ")}`.trim());
    check(dryState.systemPrompt.includes("box desktop"), "it reads the system prompt off the turn under test, not off a title generator's",
      `${dryState.systemPrompt.length} chars`);

    // The reader, against the history the loop above built.
    stubState.results = dryState.results;
    const page = resultsFor("the test page");
    check(page != null, "the result reader finds a step by its place in the plan");
    check(textOf(page).includes(PAGE_PROSE), "and hands back the text the model was shown", oneLine(textOf(page), 80));
    check(imagesOf(page).length === 1, "with exactly one image part", `${imagesOf(page).length}`);
    check(page?.followingImages === 1, "and one image part on the wire beside it", `${page?.followingImages}`);
    check(imagesOf(page)[0]?.mimeType === SHOT_MIME, `the image part is a ${SHOT_MIME}`);

    // And the pages themselves, over HTTP, because a fixture that does not say what the
    // assertions look for turns the whole run into a false failure.
    const get = async (route) => {
      const res = await fetch(`http://127.0.0.1:${FIXTURE_PORT}${route}`);
      return { status: res.status, body: await res.text() };
    };
    const testPage = await get("/");
    check(testPage.status === 200 && testPage.body.includes(PAGE_PROSE), "the test page serves the prose the extractor has to carry through");
    check(testPage.body.includes("SCRIPTNOISE") && testPage.body.includes("Cookie settings"),
      "and the script text and navigation junk the extractor has to drop");
    check(testPage.body.includes('id="note"') && testPage.body.includes("Save note"),
      "and the field to type in and the button to click");
    const loginPage = await get("/login");
    check(loginPage.status === 200 && loginPage.body.includes('type="password"'), "the login wall serves a password field");
    const blockedPage = await get("/blocked");
    check(blockedPage.status === 403 && /Access Denied/.test(blockedPage.body), "the challenge page answers 403 with a title the classifier knows",
      String(blockedPage.status));
    const refusedPage = await get("/refused");
    check(refusedPage.status === 403 && refusedPage.body.length === 0,
      "and the bare refusal answers 403 with nothing to render, which is the case Chrome fails outright",
      `${refusedPage.status}, ${refusedPage.body.length} bytes`);

    // ---------------------------------------------------------- CLOUD-BROWSER-1, on this Mac
    //
    // The two readers the cloud legs depend on, checked without a box, because each of them makes
    // the real run LIE rather than fail if it is wrong: an argv scanner that finds nothing because
    // its regex is wrong reports a custody check that never ran, and an engine reader that always
    // says "box" makes the desktop-invariant leg pass vacuously.
    const argvHit = cloudArgvOffenders(
      "root 1 node /opt/titanbot-runtime/browser-driver/host-op.mjs --request-file /tmp/.sand-browser/requests/req-x.json\n"
      + "root 2 node /opt/titanbot-runtime/browser-driver/host-op.mjs eyJvcCI6Im9wZW4ifQ==\n",
    );
    check(argvHit.length === 0, "the argv scanner passes a box run and a cloud run that behaved");
    const argvMiss = cloudArgvOffenders(
      "root 3 node host-op.mjs --cdp wss://api.browser-use.com/cdp/abc?token=bu_secret\n"
      + "root 4 curl -H X-BB-API-Key: bb_live_1234 https://api.browserbase.com/v1/sessions\n",
    );
    check(argvMiss.length === 2, "and catches a vendor endpoint and a vendor key in an argument list",
      `${argvMiss.length} caught`);

    const folded = parseCloudLedger(
      `{"event":"opened","sessionId":"s1","vendor":"browser-use","endedAt":null,"minutes":null,"proxyBytes":null}\n`
      + `{"event":"closed","sessionId":"s1","vendor":"browser-use","endedAt":"2026-09-09T00:00:00Z","minutes":0.4,"proxyBytes":null}\n`
      + `not json\n{"no":"session"}\n`
      + `{"event":"opened","sessionId":"s2","vendor":"browserbase","endedAt":null}\n`,
    );
    check(folded.length === 2, "the ledger reader folds two lines per session into one row", `${folded.length} rows`);
    check(folded[0].endedAt !== null && folded[0].minutes === 0.4, "and the closing line wins");
    check(folded[1].endedAt === null, "while a session that never closed stays visibly open");
    check(parseCloudLedger("").length === 0, "and an empty ledger is no sessions, never an error");
  } finally {
    await new Promise((resolve) => dryStub.close(resolve));
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  console.log(`\n${failures === 0 ? "OK — dry run" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  if (VENDORS_ONLY) {
    // Nothing on the box is touched, so nothing has to be put back. The metered arm below is the
    // whole run, and the finally's restores are all no-ops because no flag above was ever set.
    info("--vendors-only: the box run is skipped; only the metered vendor arm below runs");
    throw new SkipTheBoxRun();
  }
  step("the box, and this Mac's fixtures");
  const up = (await sh("echo up")).trim();
  if (up !== "up") bail(`the box ${BOX} does not answer docker exec`);
  const before = await chromeInventory();
  info(`chrome profiles running: ${[...before.profiles].join(", ") || "(none)"}`);
  info(`windows per display: ${[...before.windows].map(([d, n]) => `${d}=${n}`).join(" ") || "(none)"}`);

  fixtures = await startFixtures(FIXTURE_PORT);
  const reachable = (await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' ${FIXTURE_BASE}/health`)).trim();
  check(reachable === "200", "the box reaches this gate's fixtures on this Mac",
    `${FIXTURE_BASE}/health -> ${reachable || "no answer"}`);
  if (reachable !== "200") bail("the box cannot reach this Mac, so no fixture below can be opened");

  step("the setting");
  previousTrace = await readSetting("SAND_TOOL_TRACE");
  previousBrowserSetting = await readSetting(BROWSER_TOOLS_SETTING);
  previousAllowHosts = await readSetting(ALLOW_HOSTS_SETTING);
  settingsTouched = true;
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", "1");
  // Named, not switched off: the refusal legs below still have to fail on a local file and on
  // loopback while the fixtures on this Mac open normally.
  await writeSetting(ALLOW_HOSTS_SETTING, "host.docker.internal");
  check(await readSetting(ALLOW_HOSTS_SETTING) === "host.docker.internal",
    `${ALLOW_HOSTS_SETTING} names only this Mac, so the fixtures open and nothing else private does`);
  // Default ON is the contract, so the ON leg runs with the setting ABSENT rather than pinned to
  // "1". A gate that writes "1" first would pass just as well against a default-off build.
  if (previousBrowserSetting !== undefined) await writeSetting(BROWSER_TOOLS_SETTING, null);
  check(await readSetting(BROWSER_TOOLS_SETTING) === undefined,
    `${BROWSER_TOOLS_SETTING} is unset for the on leg, so the default is what is measured`,
    previousBrowserSetting === undefined ? "it was already unset" : `it was ${JSON.stringify(previousBrowserSetting)}, restored at the end`);

  // ---------------------------------------------------------- CLOUD-BROWSER-1, the cloud path
  //
  // --cloud-shape sends every one of the four tools down the CLOUD path -- the request file, the
  // attach-by-URL, the same page reader, the same JPEG, the same verdicts -- against the box's own
  // Chrome debugger. No vendor is dialled and nothing is spent, and what gets proved is the claim
  // this wave actually makes: the shape is identical because it is the same code, not because two
  // implementations agree. The router's loopback guard refuses anything that is not ws:// on
  // 127.0.0.1, so this setting cannot be turned into a way to point the browser elsewhere.
  //
  // The endpoint is asked of Chrome itself rather than assembled from a port, because a browser
  // that is not up yet has no endpoint and a run against a guessed one fails with nothing to read.
  if (CLOUD_SHAPE) {
    step("the cloud path, against this box's own browser");
    previousCloudCdp = await readSetting(CLOUD_CDP_SETTING);
    previousEngines = (await sh(`cat ${CLOUD_ENGINES_FILE} 2>/dev/null || true`)).trim();
    cloudTouched = true;
    // WARM THE BROWSER FIRST, through the product's own path. Chrome has no debugger endpoint until
    // it is running, and a cold start is about 45 seconds (measured on this Mac 2026-09-09: 45,561
    // ms cold against 1,317 ms warm). Warming it here also keeps that 45 seconds out of the timings
    // every leg below takes.
    const warm = Buffer.from(JSON.stringify({ op: "screenshot", display: 1, cdpPort: 9223 }), "utf8").toString("base64");
    const warmed = Date.now();
    await sh(`node /opt/titanbot-runtime/browser-driver/host-op.mjs ${warm} >/dev/null 2>&1 || true`);
    info(`browser warmed in ${Date.now() - warmed} ms`);
    let endpoint = "";
    const cdpBy = Date.now() + 90_000;
    while (Date.now() < cdpBy && endpoint.length === 0) {
      const found = (await sh(
        `for p in 9222 9223 9224 9225 9226 9227 9228; do`
        + ` u=$(curl -s -m 2 http://127.0.0.1:$p/json/version 2>/dev/null | tr ',' '\\n' | grep -m1 webSocketDebuggerUrl | sed 's/.*"ws:/ws:/;s/"$//');`
        + ` [ -n "$u" ] && { echo "$u"; break; }; done`,
      )).trim();
      if (found.startsWith("ws://")) { endpoint = found; break; }
      await sleep(5000);
    }
    if (endpoint.length === 0) {
      skip("the cloud path runs against this box's own browser", "no Chrome debugger endpoint answered on this box");
    } else {
      info(`loopback debugger endpoint: ${endpoint.replace(/\/devtools\/browser\/.*/, "/devtools/browser/...")}`);
      await writeSetting(CLOUD_CDP_SETTING, endpoint);
      // Pinned to a cloud engine so EVERY page in the plan takes the cloud path, rather than only
      // the ones on the site list. A partial run would leave the shape claim half-measured.
      //
      // Written base64 and decoded in the box. Quoting a JSON document through `docker exec sh -lc`
      // is the trap this repo has been bitten by more than once: one apostrophe in the payload and
      // the shell reads the rest as something else entirely, usually silently.
      await writeBoxFileB64(CLOUD_ENGINES_FILE, JSON.stringify({
        engine: "browser-use", cloudSites: [], autoEscalate: true, sessionCeilingPerTurn: 20, preferred: "browser-use",
      }));
      // A browser is held for the life of the PAGE now, not of the tool call, so the run's last
      // page is still holding one when the plan ends -- which is correct and is also the one thing
      // that would make "every session closed" fail for the right reason. The idle timer is what
      // gives it back, and four minutes is longer than this gate may take, so the box is asked to
      // use a short one while the arm runs. It is restored with everything else in the finally.
      previousCloudIdle = await readSetting(CLOUD_IDLE_SETTING);
      await writeSetting(CLOUD_IDLE_SETTING, String(CLOUD_IDLE_SECONDS));
      cloudLedgerBefore = parseCloudLedger(await sh(`cat ${CLOUD_LEDGER_FILE} 2>/dev/null || true`)).length;
      check(await readSetting(CLOUD_CDP_SETTING) === endpoint, "the box is pointed at its own browser through the cloud path");
      info(`cloud ledger rows before this run: ${cloudLedgerBefore}, idle release at ${CLOUD_IDLE_SECONDS}s`);
    }
  }

  step("the stub, and the box pointed at it");
  stub = await startStub(STUB_PORT, PLAN, stubState);
  const stubReachable = (await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://host.docker.internal:${STUB_PORT}/v1/models`)).trim();
  check(stubReachable === "200", "the box reaches the stub model on this Mac",
    `host.docker.internal:${STUB_PORT} -> ${stubReachable || "no answer"}`);
  if (stubReachable !== "200") bail("the box cannot reach the stub model on this Mac");

  const endpointsBefore = await relay("/endpoints");
  // A run that was killed between the pin and the restore leaves the box answering through a stub
  // that is no longer listening. Starting again on top of that would record the DEAD STUB as the
  // endpoint to put back, and the box would be left broken by a gate that reported green. Refuse,
  // and say which endpoint an operator has to pin by hand first.
  if (endpointsBefore.live?.model === STUB_MODEL) {
    const candidates = (endpointsBefore.endpoints ?? [])
      .filter((e) => e.id !== STUB_ID && e.health?.serves === true).map((e) => e.id);
    bail("the box is still pointed at this gate's stub model from an earlier run that did not finish."
      + " Pin it back to a real endpoint before running this again"
      + (candidates.length > 0 ? `, for example: curl -s -X POST ${GATEWAY}/endpoints/use -H 'content-type: application/json' -d '{"id":"${candidates[0]}"}'` : ""));
  }
  previousEndpoint = (endpointsBefore.endpoints ?? [])
    .find((e) => e.baseUrl === endpointsBefore.live?.baseUrl && e.model === endpointsBefore.live?.model)?.id ?? null;
  if (previousEndpoint == null) bail("the live endpoint could not be identified, so it will not be repinned blindly");
  const kept = (endpointsBefore.endpoints ?? []).filter((e) => e.id !== STUB_ID)
    .map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
  await relay("/endpoints", { endpoints: [...kept, { id: STUB_ID, name: "browser tools gate stub", baseUrl: `http://host.docker.internal:${STUB_PORT}/v1`, model: STUB_MODEL, apiKey: "" }] });
  endpointsTouched = true;
  await relay("/endpoints/use", { id: STUB_ID });
  info(`the box is answering through the stub; it was on ${previousEndpoint}`);

  step("one turn on a scratch agent");
  const made = await gw("createAgent", {
    name: `verify-browser-${Math.random().toString(36).slice(2, 8)}`,
    description: "Throwaway agent for the browser-tools gate. Safe to delete.",
    origin: "user", isKickstartRequested: false,
  });
  agentId = made?.id ?? made?.agent?.id ?? made?.body?.id ?? made?.body?.agent?.id ?? null;
  check(agentId != null, "a scratch agent to drive the turn on", agentId == null ? JSON.stringify(made).slice(0, 160) : String(agentId));
  if (agentId == null) bail("createAgent gave back no id, so there is no turn to drive");

  const from = await hostLogLines();
  await gw("sendPrompt", {
    agentId,
    prompt: "Open the pages I asked about and tell me what you found. Do it yourself; do not delegate.",
  });
  const deadline = Date.now() + TIMEOUT_MS;
  let chief = null;
  let wire = null;
  while (Date.now() < deadline) {
    await sleep(5000);
    const lines = await toolsetLinesSince(from);
    chief ??= lines.find((line) => line.conversationId === agentId && !line.isSubagentRunner) ?? null;
    wire ??= (await wireLinesSince(from))
      .find((line) => line.conversationId === agentId && (line.tools ?? []).includes("browser_open")) ?? null;
    const browserResults = stubState.results.filter((r) => r.name.startsWith("browser_"));
    if (browserResults.length >= PLAN.length) break;
  }
  // The plan is what this gate measures, and it is spent. Waiting for the agent to stop as WELL as
  // finish the plan is what hung this gate: measured on grok-bot-local-vm 2026-09-07, all eight
  // steps ran and the agent still read as running afterwards, because the stub's closing sentence
  // is plain text and the turn's own reminder asks for a SendMessage tool call it will never make.
  // So: a short grace for the turn to settle, then read the results either way.
  const settleBy = Date.now() + 20_000;
  while (Date.now() < settleBy) {
    const running = (await gw("listAgents").catch(() => [])).find((a) => a.id === agentId)?.isRunning === true;
    if (!running) break;
    await sleep(3000);
  }
  info(`the stub answered ${stubState.requests} request(s) and dispatched: ${stubState.dispatched.join(", ") || "(nothing)"}`);

  // ---------------------------------------------------------- 1 and 2: offered, and on the wire
  step("the four tools reach Titan himself");
  if (chief == null) {
    skip("the chief's toolset line", "no [sand][toolset] line for this agent; is SAND_TOOL_TRACE readable in the box?");
  } else {
    const offeredBrowser = chief.tools.filter((name) => name.startsWith("browser_"));
    info(`the chief was offered ${chief.count} tools, ${offeredBrowser.length} of them browser_*: ${offeredBrowser.join(", ") || "(none)"}`);
    for (const name of TITAN_BROWSER_TOOLS) {
      check(chief.tools.includes(name), `${name} is in the main agent's own toolset`,
        chief.tools.includes(name) ? "" : "withheld: " + ((chief.withheld ?? []).find((w) => w.tool === name)?.reason ?? "not even named on the withheld list"));
    }
    check(chief.isSubagentRunner !== true, "and it is the main agent's line, not a subagent's",
      `isSubagentRunner=${chief.isSubagentRunner ?? "(absent)"}`);
  }
  if (wire == null) {
    check(false, "the four leave for the provider", "no [sand][wire] line for this agent carried browser_open");
  } else {
    info(`wire: ${wire.transport} ${wire.model} offered ${wire.offered} sent ${wire.sent}`);
    const sentBrowser = TITAN_BROWSER_TOOLS.filter((name) => (wire.tools ?? []).includes(name));
    check(sentBrowser.length === TITAN_BROWSER_TOOLS.length, "all four left in the request that went to the provider",
      `${sentBrowser.length} of ${TITAN_BROWSER_TOOLS.length}: ${sentBrowser.join(", ")}`);
    check(wire.sent === wire.offered, "the request dropped no tool on the way out",
      `offered ${wire.offered}, sent ${wire.sent}`);
  }
  check(stubState.missingTools.length === 0, "the stub found every tool its plan calls for",
    stubState.missingTools.length === 0 ? "" : `missing: ${[...new Set(stubState.missingTools)].join(", ")}`);
  check(stubState.unknownArgs.length === 0, "and every argument name the plan uses is in the advertised schema",
    stubState.unknownArgs.length === 0 ? "" : `not advertised: ${[...new Set(stubState.unknownArgs)].join(", ")}`);

  // ---------------------------------------------------------- 3: the prompt
  step("what the prompt tells the model to do with them");
  const prompt = stubState.systemPrompt;
  if (prompt.length === 0) {
    skip("the system prompt's browser rules", "the stub never saw a system prompt");
  } else {
    info(`system prompt: ${prompt.length} chars`);
    check(!/Delegate every browser and desktop interaction/i.test(prompt),
      "the prompt no longer tells Titan to delegate every browser interaction",
      /Delegate every browser and desktop interaction/i.test(prompt) ? "the old sentence is still there, and it contradicts the four tools he now holds" : "");
    check(/browser/i.test(prompt) && /(one page|a single page|for one page)/i.test(prompt),
      "it says to use the browser himself for one page");
    check(/(long|multi-step|many steps)/i.test(prompt) && /(subagent|delegate)/i.test(prompt),
      "and to delegate a long, multi-step job to the desktop subagent");
    check(/sign in/i.test(prompt) && /(desktop view|desktop)/i.test(prompt),
      "it tells him to hand a login back through the desktop view");
    // The ladder: fetch, then TinyFish, then the browser, because the browser is the expensive read.
    //
    // Measured INSIDE the rule that states it, not across the whole prompt. A whole-prompt word
    // search reports the first place each word appears anywhere, and this prompt names the browser
    // early, in the escalation ladder, thousands of characters before the reading rule -- so the
    // check failed (fetch 991, TinyFish 88478, browser 23818) on a prompt whose reading rule is in
    // exactly the right order. What has to be in order is one rule, and this reads that rule.
    const READING_RULE = /Read the web in this order[\s\S]{0,900}/i;
    const rule = prompt.match(READING_RULE)?.[0] ?? "";
    check(rule.length > 0, "the prompt carries one rule that states the reading order",
      rule.length > 0 ? `${rule.length} chars` : "no sentence starting \"Read the web in this order\" is in the prompt");
    const where = rule.length > 0 ? rule : prompt;
    const fetchAt = where.search(/WebFetch|web fetch|fetch the page/i);
    const tinyfishAt = where.search(/TinyFish/i);
    const browserAt = where.search(/browser/i);
    check(fetchAt >= 0 && browserAt >= 0 && fetchAt < browserAt,
      "the reading ladder puts fetch before the browser",
      `fetch at ${fetchAt}, TinyFish at ${tinyfishAt}, browser at ${browserAt}`);
    if (tinyfishAt < 0) skip("TinyFish sits between them in the ladder", "the rule never names TinyFish (CURSOR-1 owns that half)");
    else check(fetchAt < tinyfishAt && tinyfishAt < browserAt, "TinyFish sits between them in the ladder",
      `fetch ${fetchAt}, TinyFish ${tinyfishAt}, browser ${browserAt}`);
  }

  // ---------------------------------------------------------- 4: real pages come back as words
  step("what came back");
  const everyBrowserResult = stubState.results.filter((r) => r.name.startsWith("browser_"));
  check(everyBrowserResult.length === PLAN.length, "every step of the plan ran",
    `${everyBrowserResult.length} of ${PLAN.length}: ${everyBrowserResult.map((r) => r.name).join(", ")}`);

  if (OFFLINE) {
    skip("example.com comes back as its own words", "--offline");
    skip("the YouTube channel comes back with its title", "--offline");
  } else {
    const example = resultsFor("example.com");
    const exampleText = textOf(example);
    info(`example.com: ${oneLine(exampleText)}`);
    check(/example domain/i.test(exampleText), "example.com comes back as its own words",
      exampleText.length === 0 ? "the result carried no text at all" : "");
    // Its body, not its title. The exact wording is the page's to change and it has changed once
    // already ("illustrative examples in documents" became "documentation examples without needing
    // permission"), so what is pinned is the part that has been on that page for years.
    check(/for use in [a-z ]*examples/i.test(exampleText), "including the sentence in its body, not just the title",
      oneLine(exampleText, 120));

    const youtube = resultsFor("the YouTube channel");
    const youtubeText = textOf(youtube);
    info(`youtube: ${oneLine(youtubeText)}`);
    check(/titanium computing/i.test(youtubeText), "the YouTube channel comes back with its title",
      youtubeText.length === 0 ? "the result carried no text at all" : "");
  }

  // ---------------------------------------------------------- 5 and 6: the login wall, the block
  const login = resultsFor("the login wall");
  const loginText = textOf(login);
  info(`the login wall: ${oneLine(loginText)}`);
  check(/needsLogin|needs a sign-in|sign in/i.test(login?.raw ?? ""), "a login-walled page is reported as needing a login",
    loginText.length === 0 ? "the result carried no text at all" : "");
  check(/sign in|log in|signed in/i.test(loginText), "and it says so in plain words, not a flag name",
    oneLine(loginText, 120));
  check(!/needsLogin\s*[:=]\s*true/i.test(loginText) || /sign in/i.test(loginText),
    "the plain-words sentence is what the model reads, whatever the flag is called");

  const blocked = resultsFor("the challenge page");
  const blockedText = textOf(blocked);
  info(`the challenge page: ${oneLine(blockedText)}`);
  check(/blocked|refused|denied|challenge/i.test(blockedText + (blocked?.raw ?? "")),
    "a page that refuses us is reported as blocked", oneLine(blockedText, 120));

  // The same verdict about a refusal with NO body, which is what a real site sends. Chrome fails
  // the navigation outright for that one, so before this it came back as
  // "net::ERR_HTTP_RESPONSE_CODE_FAILURE" with blocked never set and the page never read.
  const bare = resultsFor("the bare refusal");
  const bareText = textOf(bare);
  info(`the bare refusal: ${oneLine(bareText)}`);
  check(bare != null && bare.parsed?.isError !== true,
    "a refusal with no page to show still comes back as an answer", oneLine(bareText, 120));
  check(/would not show this page|blocked|refused|denied/i.test(bareText + (bare?.raw ?? "")),
    "and it is reported as blocked, not as a failure", oneLine(bareText, 120));
  check(!/net::|ERR_[A-Z_]+/.test(bareText), "with no browser error code in the words the model reads",
    oneLine(bareText, 120));

  // ---------------------------------------------------------- 7: click and type change the page
  step("typing and clicking");
  const page = resultsFor("the test page");
  const pageText = textOf(page);
  info(`the test page: ${oneLine(pageText)}`);
  check(pageText.includes(PAGE_PROSE), "the test page's main prose came back", oneLine(pageText, 120));
  check(!/SCRIPTNOISE/.test(pageText), "and the page's script text did not");
  check(!/STYLENOISE/.test(pageText), "and neither did its stylesheet");
  check(!/Cookie settings/i.test(pageText), "and neither did the navigation junk around the article",
    /Cookie settings/i.test(pageText) ? "the extractor is returning innerText, not readable main text" : "");
  check(pageText.length <= TEXT_CAP, `the text is capped at ${TEXT_CAP} chars`, `${pageText.length} chars`);

  const typed = resultsFor("typing the note");
  const clicked = resultsFor("clicking Save note");
  const shot = resultsFor("a screenshot");
  check(typed != null && typed.parsed?.isError !== true, "browser_type ran without an error",
    oneLine(textOf(typed), 120));
  check(clicked != null && clicked.parsed?.isError !== true, "browser_click ran without an error",
    oneLine(textOf(clicked), 120));
  // The page's own proof: the click handler writes the typed note into #result, so the words
  // "note saved: titan was here" exist nowhere until both actions actually landed.
  const afterClick = `${textOf(clicked)}\n${textOf(shot)}`;
  check(new RegExp(`note saved:\\s*${NOTE_TEXT}`, "i").test(afterClick),
    "the click and the typing changed the page the way the page says they should",
    oneLine(afterClick, 160) || "nothing came back from the click");

  // ---------------------------------------------------------- 8: text plus exactly one image
  step("text plus one image, every time");
  for (const entry of PLAN) {
    // A refused address never reaches the box, so there is no picture of it to check. Leg 12 is
    // where those are measured.
    if (entry.refuses === true) continue;
    const result = resultsFor(entry.label);
    if (result == null) { check(false, `${entry.label}: a result came back`, "nothing"); continue; }
    const images = imagesOf(result);
    const hasText = textOf(result).length > 0;
    check(hasText && images.length === 1, `${entry.label}: text plus exactly one image part`,
      `${hasText ? "text" : "NO TEXT"}, ${images.length} image part(s), ${result.followingImages} on the wire`);
    if (images.length !== 1) continue;
    const image = images[0];
    check(image.mimeType === SHOT_MIME, `${entry.label}: the image is a ${SHOT_MIME}`, String(image.mimeType));
    const bytes = Buffer.from(String(image.data ?? ""), "base64");
    const size = jpegSize(bytes);
    check(size != null, `${entry.label}: and the bytes really are a JPEG`,
      size == null ? `${bytes.length} bytes, no start-of-frame marker` : `${bytes.length} bytes`);
    if (size != null) {
      check(size.width === SHOT_WIDTH, `${entry.label}: resized to ${SHOT_WIDTH} wide`, `${size.width}x${size.height}`);
    }
    check(result.followingImages === 1, `${entry.label}: exactly one image part left in the request`,
      `${result.followingImages}`);
  }
  const historyImages = Math.max(0, ...(await wireLinesSince(from)).map((line) => Number(line.historyImageParts ?? 0)));
  const wireImages = Math.max(0, ...(await wireLinesSince(from)).map((line) => Number(line.imageParts ?? 0)));
  info(`image parts: ${historyImages} in the turn history, ${wireImages} in the request that left`);
  check(!(historyImages > 0 && wireImages === 0),
    "the rendered screenshots survived the history flattener (SUB-2b)",
    historyImages > 0 && wireImages === 0 ? "every image was dropped before the request left" : "");

  // ---------------------------------------------------------- 9: the audit ledger
  step("the audit ledger");
  const ledger = await sh(`cat ${AGENTS_DIR}/${agentId}/audit.jsonl 2>/dev/null || true`);
  const rows = ledger.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((row) => row.type === "browser_navigation");
  info(`browser_navigation rows for this agent: ${rows.length}`);
  for (const row of rows) info(`  ${oneLine(row.url, 90)} — ${oneLine(row.pageTitle, 50)}`);
  const opens = PLAN.filter((entry) => entry.tool === "browser_open" && entry.refuses !== true).length;
  check(rows.length >= opens, `one browser_navigation row per open (${opens} opens)`, `${rows.length} row(s)`);
  check(rows.every((row) => typeof row.url === "string" && row.url.length > 0),
    "every row carries the url it opened");
  check(rows.every((row) => typeof row.pageTitle === "string" && row.pageTitle.length > 0),
    "and the page title it found",
    rows.filter((row) => !(typeof row.pageTitle === "string" && row.pageTitle.length > 0)).length + " row(s) with no title");
  const ledgerUrls = rows.map((row) => String(row.url));
  check(!ledgerUrls.some((url) => url.startsWith("chrome-error:")),
    "and it is the address that was asked for, not Chrome's own error page",
    ledgerUrls.filter((url) => url.startsWith("chrome-error:")).join(", "));
  check(ledgerUrls.some((url) => url.includes("/refused")), "the bare refusal is in the ledger by its own address");
  check(ledgerUrls.some((url) => url.includes("/login")), "the login wall is in the ledger");
  if (!OFFLINE) check(ledgerUrls.some((url) => url.includes("example.com")), "and so is example.com");

  // ---------------------------------------------------------- 10: the same Chrome
  step("the desktop view still shows the same Chrome");
  const after = await chromeInventory();
  info(`chrome profiles running: ${[...after.profiles].join(", ") || "(none)"}`);
  info(`windows per display: ${[...after.windows].map(([d, n]) => `${d}=${n}`).join(" ") || "(none)"}`);
  const newProfiles = [...after.profiles].filter((profile) => !before.profiles.has(profile));
  check(newProfiles.length === 0, "no second Chrome came up on a profile of its own",
    newProfiles.length === 0 ? "" : `new: ${newProfiles.join(", ")}; the operator would be watching one browser while Titan drove another`);
  const doubled = [...after.windows].filter(([display, count]) => {
    const was = before.windows.get(display) ?? 0;
    return was > 0 && count >= was * 2;
  });
  check(doubled.length === 0, "and no display's window count doubled",
    doubled.length === 0 ? "" : doubled.map(([d, n]) => `${d}: ${before.windows.get(d)} -> ${n}`).join(", "));

  // CLOUD-BROWSER-1. The leg above passes trivially if nothing browsed at all, so on a cloud run it
  // has to learn which engine actually ran. The ledger is the evidence, because it is the thing the
  // product writes anyway: one row per cloud session, box and vendor and minutes on it. No rows
  // means the cloud path never ran and "the browser did not double" proved nothing.
  const ledgerRows = parseCloudLedger(await sh(`cat ${CLOUD_LEDGER_FILE} 2>/dev/null || true`));
  if (CLOUD_SHAPE) {
    const gained = ledgerRows.length - cloudLedgerBefore;
    check(gained > 0, "and the cloud path is what ran, on the ledger's own word",
      `${gained} new session row(s); without one, the invariant above proved nothing`);
    // A browser is held for the page now, so the run's last page is still holding one at this
    // point. That is the fix, not a leak -- and the thing that has to be proved is that the idle
    // timer gives it back. The box was told to use a short one at the top of this arm, so this
    // waits that long plus a margin and then asks the ledger again. A session that is still open
    // after that IS a leak, and the same number would have looked fine under the old assertion.
    const openNow = ledgerRows.filter((row) => row.endedAt == null).length;
    info(`cloud sessions still held when the plan ended: ${openNow}`);
    check(openNow <= 1, "at most one browser is held when the run ends, which is the page it left open",
      `${openNow} open`);
    const releaseBy = Date.now() + (CLOUD_IDLE_SECONDS + 25) * 1000;
    let openAfter = openNow;
    while (Date.now() < releaseBy && openAfter > 0) {
      await sleep(3000);
      openAfter = parseCloudLedger(await sh(`cat ${CLOUD_LEDGER_FILE} 2>/dev/null || true`))
        .filter((row) => row.endedAt == null).length;
    }
    check(openAfter === 0, `and the idle timer gives it back within ${CLOUD_IDLE_SECONDS}s of nothing using it`,
      `${openAfter} still open`);
    ledgerRows.length = 0;
    ledgerRows.push(...parseCloudLedger(await sh(`cat ${CLOUD_LEDGER_FILE} 2>/dev/null || true`)));
    // `boxName`, not `tenant`: a box holds no control-plane slug, and the field is named after what
    // it actually holds. The relay is what stamps the tenant onto what the admin panel reads.
    const named = ledgerRows.filter((row) => String(row.boxName ?? row.tenant ?? "").length > 0 && String(row.vendor ?? "").length > 0);
    check(named.length === ledgerRows.length, "and every row names the box it ran on and an engine");
    info(`cloud sessions on the ledger: ${ledgerRows.length} (${gained} from this run)`);
  } else {
    info(`cloud sessions on the ledger: ${ledgerRows.length} (this run used the box's own browser)`);
  }

  // ------------------------------------------- the console's own side of the cloud browser, in a
  // REAL browser.
  //
  // ui/machine-room/cloud-browser.js shipped complete, self-mounting, and with no <script> tag
  // loading it: 290 lines that never ran, on a box, for a release. A person could therefore never
  // take over a cloud session, while two documents said they could. A file with no gate behind it
  // is exactly how that happens, so this opens the console the way a person does and asks whether
  // the strip is on the screen -- not whether the file exists, which was already true.
  step("the console draws where the browser is running");
  if (!existsSync(CHROME)) {
    skip("the Computer card says where the browser runs", `no Chrome at ${CHROME}; set GROK_BOT_CHROME`);
  } else {
    const { chromium } = await import("../.cache/playwright/node_modules/playwright-core/index.mjs");
    const consoleBrowser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const consolePage = await consoleBrowser.newPage();
      await consolePage.goto(`${GATEWAY}/`, { waitUntil: "load" });
      // The tag itself, first, because that is the regression: a module the page never loads.
      const tagged = await consolePage.evaluate(() =>
        [...document.querySelectorAll("script[src]")].some((tag) => /cloud-browser\.js/.test(tag.getAttribute("src") || "")));
      check(tagged, "the console loads the cloud browser module", tagged ? "" : "no <script src=cloud-browser.js> in index.html");
      const mounted = await consolePage.evaluate(() => typeof window.__cloudBrowser === "object" && window.__cloudBrowser != null);
      check(mounted, "and the module mounted in the page");
      // Then the thing a person actually sees. The strip polls, so it is waited for rather than
      // read once; a strip that needs a click to appear is not a strip on the screen.
      let strip = "";
      for (let n = 0; n < 40 && strip.length === 0; n += 1) {
        strip = await consolePage.evaluate(() => {
          const node = document.getElementById("cloud-browser-strip");
          if (node == null) return "";
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0 ? node.textContent.replace(/\s+/g, " ").trim() : "";
        });
        if (strip.length === 0) await consolePage.waitForTimeout(500);
      }
      check(strip.length > 0, "and the Computer card says where the browser is running", strip || "the strip never appeared on screen");
      check(/this computer|cloud browser/i.test(strip), "in plain words a person reads", strip);
      // The rule this console holds everywhere: no vendor's name in anything a person reads.
      const vendorNamed = /browserbase|browser use/i.test(strip);
      check(!vendorNamed, "and it names no vendor", vendorNamed ? strip : "");
    } finally {
      await consoleBrowser.close().catch(() => {});
    }
  }

  // -------------------------------------------------- MARKET-17: nothing of a vendor's in any argv
  //
  // The cloud path exists because a residential exit and a saved login are worth having; the reason
  // it does not put its endpoint in a command line is that argv is readable from any process in the
  // box, the agent's own shell included, and a cloud debugger URL carries the session's credential.
  // This walks EVERY process on the box, not only the driver's, so a leak through some other path
  // is caught by the same check.
  step("nothing of a cloud browser's is in any argument list");
  const argvDump = await sh("ps -eo args 2>/dev/null || ps ax 2>/dev/null || true");
  const offenders = cloudArgvOffenders(argvDump);
  check(offenders.length === 0, "no vendor host, key or session id in any process's arguments",
    offenders.length === 0 ? `${argvDump.split("\n").filter((l) => l.trim().length > 0).length} processes read` : offenders.slice(0, 3).join(" | "));
  // And the request files the cloud path writes are cleaned up by the driver that reads them.
  const leftover = (await sh("ls -1 /tmp/.sand-browser/requests 2>/dev/null | wc -l")).trim();
  check(Number(leftover || "0") === 0, "and no cloud request file was left behind on the box",
    `${leftover} file(s) in /tmp/.sand-browser/requests`);

  // ------------------------------------------------- 12: an address that is not on the public web
  //
  // The browser reads pages with the person's own logins, on a machine that also runs their files
  // and the console. An address the model was talked into -- by a page it just read, by a peer, by
  // pasted text -- must not be able to point either of those at the provider. Measured on
  // grok-bot-local-vm 2026-09-07 before this check existed: file:///etc/passwd came back as page
  // text plus a JPEG, and so did the console on host.docker.internal:7777.
  step("addresses the browser refuses");
  for (const entry of PLAN.filter((plan) => plan.refuses === true)) {
    const result = resultsFor(entry.label);
    const text = `${textOf(result)} ${result?.raw ?? ""}`;
    info(`${entry.label}: ${oneLine(textOf(result))}`);
    check(result != null, `${entry.label}: the model got an answer about it`, "nothing came back");
    check(/only open pages on the public web/i.test(text), `${entry.label}: refused in plain words`,
      oneLine(textOf(result), 120));
    check(imagesOf(result).length === 0, `${entry.label}: and no picture of it came back`,
      `${imagesOf(result).length} image part(s)`);
  }
  // The two things those addresses would have handed over if the check were not there.
  const everyResultText = stubState.results.map((r) => `${textOf(r)} ${r.raw ?? ""}`).join("\n");
  check(!/root:x:0:0/.test(everyResultText), "no line of the box's password file reached the model");
  check(!/webSocketDebuggerUrl|Machine Room/.test(everyResultText),
    "and neither did the browser's own debug endpoint or the operator console");
  check(!ledgerUrls.some((url) => url.startsWith("file:") || url.includes("127.0.0.1")),
    "and nothing refused was written into the audit ledger");

  // ---------------------------------------------------------- 11: the setting off
  if (SKIP_OFF_LEG) {
    skip("with the setting off the four are withheld", "--no-off-leg");
  } else {
    step("with SAND_BROWSER_TOOLS off");
    // A prompt sent into a turn still running aborts it, and the abort is what the reader would
    // then be looking at instead of the withhold. Wait for the first turn to settle.
    const idleBy = Date.now() + 120_000;
    while (Date.now() < idleBy) {
      const running = (await gw("listAgents").catch(() => [])).find((a) => a.id === agentId)?.isRunning === true;
      if (!running) break;
      await sleep(4000);
    }
    await writeSetting(BROWSER_TOOLS_SETTING, "0");
    const offFrom = await hostLogLines();
    await gw("sendPrompt", { agentId, prompt: "Never mind, just say READY." });
    const offDeadline = Date.now() + 180_000;
    let offLine = null;
    while (Date.now() < offDeadline) {
      await sleep(4000);
      offLine = (await toolsetLinesSince(offFrom))
        .find((line) => line.conversationId === agentId && !line.isSubagentRunner) ?? null;
      if (offLine != null) break;
    }
    if (offLine == null) {
      skip("with the setting off the four are withheld", "no toolset line for the second turn");
    } else {
      const stillOffered = TITAN_BROWSER_TOOLS.filter((name) => offLine.tools.includes(name));
      check(stillOffered.length === 0, "with the setting off the four are withheld",
        stillOffered.length === 0 ? "" : `still offered: ${stillOffered.join(", ")}`);
      const named = new Map((offLine.withheld ?? []).map((entry) => [entry.tool, entry.reason]));
      const unexplained = TITAN_BROWSER_TOOLS.filter((name) => !named.has(name));
      check(unexplained.length === 0, "and the line says why, rather than leaving them merely absent",
        unexplained.length === 0
          ? `reason: ${named.get(TITAN_BROWSER_TOOLS[0])}`
          : `no reason given for ${unexplained.join(", ")}`);
    }
  }
} catch (error) {
  if (error instanceof SkipTheBoxRun) { /* --vendors-only; the metered arm below is the run */ }
  else if (error instanceof NothingToMeasure) nothingToMeasure = error.message;
  else check(false, "the browser-tools gate", error.message);
} finally {
  if (!VENDORS_ONLY) step("putting it back");
  if (agentId != null && !KEEP) {
    // An agent will not delete while its turn is still running, and a probe that survived a
    // passing run is exactly how a roster fills up with gate leftovers. Wait for it to settle.
    const idleBy = Date.now() + 150_000;
    while (Date.now() < idleBy) {
      const running = (await gw("listAgents").catch(() => [])).find((a) => a.id === agentId)?.isRunning === true;
      if (!running) break;
      await sleep(4000);
    }
    await gw("deleteAgent", { id: agentId }).then(() => info(`scratch agent ${agentId} deleted`))
      .catch((error) => info(`scratch agent NOT deleted: ${error.message}`));
  }
  if (endpointsTouched) {
    const endpointsBefore = await relay("/endpoints").catch(() => null);
    const kept = (endpointsBefore?.endpoints ?? []).filter((e) => e.id !== STUB_ID)
      .map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
    await relay("/endpoints", { endpoints: kept }).catch((error) => info(`catalog NOT restored: ${error.message}`));
    if (previousEndpoint != null) {
      await relay("/endpoints/use", { id: previousEndpoint })
        .then(() => info(`box restored to ${previousEndpoint}`))
        .catch((error) => info(`box NOT restored: ${error.message}`));
    }
  }
  if (cloudTouched) {
    // A box left pinned to a cloud engine would send every later page through a path the operator
    // never chose, so this is put back before anything else and whatever happened.
    await writeSetting(CLOUD_CDP_SETTING, previousCloudCdp ?? null)
      .then(() => info(`${CLOUD_CDP_SETTING} restored`))
      .catch((error) => info(`${CLOUD_CDP_SETTING} NOT restored: ${error.message}`));
    await writeSetting(CLOUD_IDLE_SETTING, previousCloudIdle ?? null)
      .then(() => info(`${CLOUD_IDLE_SETTING} restored`))
      .catch((error) => info(`${CLOUD_IDLE_SETTING} NOT restored: ${error.message}`));
    await (previousEngines.length > 0
      ? writeBoxFileB64(CLOUD_ENGINES_FILE, previousEngines)
      : sh(`rm -f ${CLOUD_ENGINES_FILE}`))
      .then(() => info(`${CLOUD_ENGINES_FILE} restored`))
      .catch((error) => info(`${CLOUD_ENGINES_FILE} NOT restored: ${error.message}`));
  }
  if (settingsTouched) {
    await writeSetting(BROWSER_TOOLS_SETTING, previousBrowserSetting ?? null)
      .catch((error) => info(`${BROWSER_TOOLS_SETTING} NOT restored: ${error.message}`));
    await writeSetting(ALLOW_HOSTS_SETTING, previousAllowHosts ?? null)
      .catch((error) => info(`${ALLOW_HOSTS_SETTING} NOT restored: ${error.message}`));
    if (previousTrace !== "1") {
      await writeSetting("SAND_TOOL_TRACE", previousTrace ?? null)
        .catch((error) => info(`SAND_TOOL_TRACE NOT restored: ${error.message}`));
    }
  }
  if (stub != null) await new Promise((resolve) => stub.close(resolve));
  if (fixtures != null) await new Promise((resolve) => fixtures.close(resolve));
}

/* ------------------------------------------------------------------ --cloud-live, metered
 *
 * ONE short session per vendor. No loops, no blind retry, and every session's state read back from
 * the vendor afterwards so "it was stopped" is the vendor's word and not ours -- Browser Use's own
 * docs say closing the CDP connection does NOT end the browser, so a session nobody asked the
 * vendor to stop is a browser billing by the hour.
 *
 * This runs from this Mac rather than inside the box, because it is measuring the VENDOR, not the
 * product: what a session costs, what it reports, and whether the stop works. Keys come from
 * ~/.api_keys by exact name and never appear in this output.
 *
 * Skipped, loudly, with no key. A metered leg that silently does nothing is worse than one that
 * says it did nothing.
 */
if (CLOUD_LIVE) {
  step("one metered session per vendor");
  const keys = await readApiKeys();
  const bytes = (n) => (typeof n === "number" ? `${(n / (1024 * 1024)).toFixed(2)} MB` : "not reported by this vendor");

  if (!keys.BROWSER_USE_API_KEY) {
    skip("Browser Use: one short session", "no BROWSER_USE_API_KEY in ~/.api_keys");
  } else {
    const started = Date.now();
    const created = await vendorCall("https://api.browser-use.com/api/v4/browsers", {
      method: "POST",
      headers: { "X-Browser-Use-API-Key": keys.BROWSER_USE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ proxyCountryCode: "us", timeoutSeconds: 300 }),
    });
    check(created.ok === true, "Browser Use opened one session", `HTTP ${created.status}`);
    const sessionId = String(created.body?.id ?? "");
    if (sessionId.length === 0) {
      check(false, "and said which session it was", JSON.stringify(created.body).slice(0, 160));
    } else {
      // MEASURED 2026-09-09: this vendor's cdpUrl is not a ws:// URL. Their own docs hand it to
      // Playwright's connect_over_cdp, which takes an http endpoint and resolves /json/version
      // itself -- so the driver has to accept BOTH shapes, and this leg asserts the shape rather
      // than assuming one. The scheme is printed because that is the fact worth having on the row.
      const cdpUrl = String(created.body?.cdpUrl ?? "");
      const scheme = /^([a-z]+):/i.exec(cdpUrl)?.[1]?.toLowerCase() ?? "";
      check(["ws", "wss", "http", "https"].includes(scheme),
        "and handed back an endpoint the box driver can attach to", `scheme: ${scheme || "(none)"}`);
      // THE STOP, in a finally of its own: whatever happened above, the browser ends here.
      let stopped = null;
      try {
        // Read the state first. Nothing in this wave is retried or stopped without a read.
        const state = await vendorCall(`https://api.browser-use.com/api/v4/browsers/${sessionId}`, {
          headers: { "X-Browser-Use-API-Key": keys.BROWSER_USE_API_KEY },
        });
        info(`Browser Use session state before the stop: ${String(state.body?.status ?? `HTTP ${state.status}`)}`);
      } finally {
        stopped = await vendorCall(`https://api.browser-use.com/api/v4/browsers/${sessionId}`, {
          method: "PATCH",
          headers: { "X-Browser-Use-API-Key": keys.BROWSER_USE_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      }
      check(stopped.ok === true || stopped.status === 404 || stopped.status === 409,
        "and the session was stopped at the vendor", `HTTP ${stopped.status}`);
      const after = await vendorCall(`https://api.browser-use.com/api/v4/browsers/${sessionId}`, {
        headers: { "X-Browser-Use-API-Key": keys.BROWSER_USE_API_KEY },
      });
      const status = String(after.body?.status ?? "").toLowerCase();
      check(after.status === 404 || status === "" || !["running", "active", "started"].includes(status),
        "and the vendor's own answer says it is no longer running", `HTTP ${after.status} ${status || "(no status)"}`);
      info(`Browser Use: ${((Date.now() - started) / 60_000).toFixed(2)} min, proxy ${bytes(after.body?.proxyBytes)}`);
    }
  }

  if (!keys.BROWSERBASE_API_KEY || !keys.BROWSERBASE_PROJECT_ID) {
    skip("Browserbase: one short session", "no BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in ~/.api_keys");
  } else {
    const started = Date.now();
    const created = await vendorCall("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { "X-BB-API-Key": keys.BROWSERBASE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ projectId: keys.BROWSERBASE_PROJECT_ID, proxies: true, timeout: 60 }),
    });
    check(created.ok === true, "Browserbase opened one session", `HTTP ${created.status}`);
    const sessionId = String(created.body?.id ?? "");
    if (sessionId.length === 0) {
      check(false, "and said which session it was", JSON.stringify(created.body).slice(0, 160));
    } else {
      check(typeof created.body?.connectUrl === "string" && created.body.connectUrl.startsWith("wss://"),
        "and handed back a wss endpoint the box driver can attach to");
      const live = await vendorCall(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
        headers: { "X-BB-API-Key": keys.BROWSERBASE_API_KEY },
      });
      check(typeof live.body?.debuggerFullscreenUrl === "string" && live.body.debuggerFullscreenUrl.length > 0,
        "and a live view a person can drive", `HTTP ${live.status}`);
      // Read, then stop. The proxy figure is only true after the browsing, so it is read here and
      // not off the create answer, where it is always zero.
      const before = await vendorCall(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        headers: { "X-BB-API-Key": keys.BROWSERBASE_API_KEY },
      });
      const stopped = await vendorCall(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        method: "POST",
        headers: { "X-BB-API-Key": keys.BROWSERBASE_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ projectId: keys.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
      });
      check(stopped.ok === true || stopped.status === 404 || stopped.status === 409,
        "and the session was stopped at the vendor", `HTTP ${stopped.status}`);
      const after = await vendorCall(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        headers: { "X-BB-API-Key": keys.BROWSERBASE_API_KEY },
      });
      const status = String(after.body?.status ?? "").toUpperCase();
      check(after.status === 404 || !["RUNNING", "PENDING"].includes(status),
        "and the vendor's own answer says it is no longer running", `HTTP ${after.status} ${status || "(no status)"}`);
      info(`Browserbase: ${((Date.now() - started) / 60_000).toFixed(2)} min, proxy ${bytes(after.body?.proxyBytes ?? before.body?.proxyBytes)}`);
    }
  }
}

if (nothingToMeasure.length > 0) {
  console.log(`\nNOTHING COULD BE MEASURED — ${nothingToMeasure}`);
  process.exit(2);
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}${unmeasured > 0 ? `, ${unmeasured} not measured` : ""}`);
process.exit(failures === 0 ? 0 : 1);
