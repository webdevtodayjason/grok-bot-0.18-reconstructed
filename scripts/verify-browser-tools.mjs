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
//   6. a challenge page says so, with blocked set
//   7. typing and clicking change a page this gate serves itself
//   8. every result is text plus exactly ONE image part, a JPEG 1280 wide
//   9. the audit ledger gained one browser_navigation row per open, with url and title
//  10. the desktop view still shows the SAME Chrome: no new profile, no doubled window count
//  11. with SAND_BROWSER_TOOLS off the four are withheld and the line says why
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
//
// Run it on its own. It repins the box's model endpoint for the length of the run, so a second
// gate running beside it would be answered by this stub.
//
// Exit 0 nothing failed, 1 something failed, 2 nothing could be measured.
import { execFile } from "node:child_process";
import http from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
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
const FIXTURE_PORT = Number.parseInt(flag("--port", "18791"), 10);
const STUB_PORT = Number.parseInt(flag("--stub-port", "18792"), 10);
const TIMEOUT_MS = Number.parseInt(flag("--timeout-ms", "420000"), 10);
const STUB_ID = "probe-browser-tools";
const STUB_MODEL = "probe-browser-tools-model";
// The four Titan gets. The other eleven stay with the browserUse subagent.
const TITAN_BROWSER_TOOLS = ["browser_open", "browser_click", "browser_type", "browser_screenshot"];
const BROWSER_TOOLS_SETTING = "SAND_BROWSER_TOOLS";
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
  { label: "the test page", tool: "browser_open", args: { url: `${FIXTURE_BASE}/` } },
  { label: "typing the note", tool: "browser_type", args: { target: "#note", text: NOTE_TEXT, submit: false } },
  { label: "clicking Save note", tool: "browser_click", args: { target: "Save note" } },
  { label: "a screenshot", tool: "browser_screenshot", args: {} },
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
let settingsTouched = false;

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
  } finally {
    await new Promise((resolve) => dryStub.close(resolve));
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  console.log(`\n${failures === 0 ? "OK — dry run" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
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
  settingsTouched = true;
  if (previousTrace !== "1") await writeSetting("SAND_TOOL_TRACE", "1");
  // Default ON is the contract, so the ON leg runs with the setting ABSENT rather than pinned to
  // "1". A gate that writes "1" first would pass just as well against a default-off build.
  if (previousBrowserSetting !== undefined) await writeSetting(BROWSER_TOOLS_SETTING, null);
  check(await readSetting(BROWSER_TOOLS_SETTING) === undefined,
    `${BROWSER_TOOLS_SETTING} is unset for the on leg, so the default is what is measured`,
    previousBrowserSetting === undefined ? "it was already unset" : `it was ${JSON.stringify(previousBrowserSetting)}, restored at the end`);

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
  const opens = PLAN.filter((entry) => entry.tool === "browser_open").length;
  check(rows.length >= opens, `one browser_navigation row per open (${opens} opens)`, `${rows.length} row(s)`);
  check(rows.every((row) => typeof row.url === "string" && row.url.length > 0),
    "every row carries the url it opened");
  check(rows.every((row) => typeof row.pageTitle === "string" && row.pageTitle.length > 0),
    "and the page title it found",
    rows.filter((row) => !(typeof row.pageTitle === "string" && row.pageTitle.length > 0)).length + " row(s) with no title");
  const ledgerUrls = rows.map((row) => String(row.url));
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
  if (error instanceof NothingToMeasure) nothingToMeasure = error.message;
  else check(false, "the browser-tools gate", error.message);
} finally {
  step("putting it back");
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
  if (settingsTouched) {
    await writeSetting(BROWSER_TOOLS_SETTING, previousBrowserSetting ?? null)
      .catch((error) => info(`${BROWSER_TOOLS_SETTING} NOT restored: ${error.message}`));
    if (previousTrace !== "1") {
      await writeSetting("SAND_TOOL_TRACE", previousTrace ?? null)
        .catch((error) => info(`SAND_TOOL_TRACE NOT restored: ${error.message}`));
    }
  }
  if (stub != null) await new Promise((resolve) => stub.close(resolve));
  if (fixtures != null) await new Promise((resolve) => fixtures.close(resolve));
}

if (nothingToMeasure.length > 0) {
  console.log(`\nNOTHING COULD BE MEASURED — ${nothingToMeasure}`);
  process.exit(2);
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}${unmeasured > 0 ? `, ${unmeasured} not measured` : ""}`);
process.exit(failures === 0 ? 0 : 1);
