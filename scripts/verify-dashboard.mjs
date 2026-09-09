#!/usr/bin/env node
// verify-dashboard.mjs -- the dashboard gate (docs/DASHBOARD-CONTRACT.md), in a real browser.
// Headless Chrome through playwright-core from GROK_BOT_PLAYWRIGHT_DIR, default .cache/playwright
// (scripts/setup-gates.sh installs it there; never a repo dependency).
// Default: the Machine Room's modals tell the truth -- the Marketplace opens on its Plugins tab
// with the host's own catalog and no provider anywhere in it (MARKET-1: providers and chat
// listeners are Settings sections now), Add and Uninstall on a catalog card write and unwrite
// connectors.json byte for byte, the box's own connectors carry their real tools, a provider card
// that cannot be adopted offers no button,
// an evidence chip opens its receipts, unread clears when a conversation is read, the Agent
// details rows carry text, and no surface still claims to be a demo. Wave C1 added: the composer
// reports the host's acceptance ledger for a send made through it (GW-03), the transcript is read
// as a tail and paged backwards through getAgentTranscriptPage (GW-03), a Skills panel imports,
// toggles, runs and deletes a workflow with every step read back through getAgentWorkflows
// (GW-05), the hand-back control and the Updates panel with its two-click Reset (GW-10), and a
// listener card's per-agent channel state (GW-08 item 2). Wave C2 added: the Agent details
// identity writes -- rename, description, avatar upload, notifications, hide-from-sidebar,
// duplicate, delete -- each read back through listAgents or getAgentAvatar (GW-01), the roster
// header's countAgents, inline attachments through readAttachmentImage and readAttachmentText
// (GW-09), and the Cmd-K palette on isGlobalSearchEnabled / searchAgents (GW-14). Two model
// turns on a probe agent it creates and deletes: the unread/acceptance prompt (which now carries
// the two attachments) and the skill run. CONNECT-3 added one bounded check to the connectors
// editor: the TinyFish (API key) preset fills the fixed entry and writes nothing on the click --
// the round trip runs against a stub server in scripts/verify-connector-plane.mjs --tinyfish-key,
// never against agent.tinyfish.ai from a shared box.
// --teach: the Learn flow is honest and stoppable (the operator's report: "there's no way to stop
//   it, so I feel like that section is also stubbed"). On a probe with its own display: the modal
//   opens only on a recording the host confirmed and its timer moves, every control in its footer
//   is painted inside the frame and hit-tests to itself, Discard reaches stopTeachRecording and
//   leaves no ffmpeg on the box, and with SAND_TEACH="0" no modal opens and the page says which
//   switch to set, beside the button that was clicked. No model turn is spent. SAND_TEACH goes
//   back to whatever the box held; --keep-setting leaves it at "1".
// --leaks: no adopted secret, no connector argv, no attested tool output and no attachment
//   preview carrying a secret in the dashboard DOM.
// --offline: with the gateway blocked, the demo factory's copy says the value was discarded and
//   the writes it does not implement are not drawn as live controls. It also carries ONBOARD-1's
//   first-run dialog and AGENTS-CAP-1's counts, both of which are drawn from the roster on the
//   page rather than from a host: ?onboarding=1 arms the demo adapter to report a box that has
//   never been set up (docs/ONBOARDING.md).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// A real PNG, built here rather than checked in: `size` × `size`, solid red. The 1×1 form is the
// avatar the GW-01 check uploads; the transcript attachment is a little larger so the model's
// vision path gets an image rather than a single pixel.
function pngOf(size) {
  const crc = (buf) => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n += 1) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Long enough that the bounded preview (1,500 chars) has to offer "Show more".
const NOTES_LINE = "gate attachment probe: the quick brown fox jumps over the lazy dog.\n";
const NOTES_TEXT = NOTES_LINE.repeat(40);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const LEAKS = process.argv.includes("--leaks");
// --offline: the same page with the gateway blocked in the browser, where the demo factory runs.
const OFFLINE = process.argv.includes("--offline");
const TEACH = process.argv.includes("--teach");
// SAND_TEACH unset is the off state, so restoring "1" onto a box that held nothing is an
// enablement, not a restore -- and an armed SAND_TEACH runs recoverPending against whichever
// agent is first in the roster at every host start. --keep-setting is how the sticky behaviour is
// asked for, the same way scripts/verify-teach.mjs asks for it.
const KEEP_TEACH_SETTING = process.argv.includes("--keep-setting");
// A live turn on a fresh agent is what this gate uses to raise an unread count. GW-15 landed
// seedSessionActivityFromDbMtime on the session store, so setAgentUnread{isUnread:true} no longer
// throws "is not a function" -- but a synthetic raise would prove only that the RPC returns, not
// that a real message reaches the badge, which is what the check is for. The box answers through
// whatever endpoint it is already on, so this runs before
// the gate touches the endpoint -- and because that makes a DOM gate depend on a provider being
// warm, a turn that does not come back inside the budget is a SKIP, not a failure. The whole gate
// has to fit the 300s verify-runner ceiling (docs/PLUMBING-AUDIT.md).
const TURN_TIMEOUT_MS = Number(process.env.GROK_BOT_TURN_TIMEOUT_MS ?? 60_000);
const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");

// Strings that claim this console is a prototype, or that it discards a value it stores.
const FORBIDDEN = ["Standalone demo", "Not wired yet", "Continue in prototype", "discarded by this demo"];

let failures = 0;
let passes = 0;
// Checks that live behind an `if (presence)` guard. When the guard is false they used to vanish
// from the run entirely, so two runs of the same file reported different totals (281 checks, then
// 274) and the seven that never executed were reported as neither passed nor failed. A skipped
// check is not a passing one: name it, count it, and print the third tally in the summary so a
// reader can see coverage moved rather than having to diff two logs to find out.
let notReachedCount = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const notReached = (why, ...labels) => { for (const label of labels) { console.log(`  SKIP  ${label} — not reached: ${why}`); notReachedCount += 1; } };
// Every call to the relay is bounded. Without this a single gateway method that never answers
// stops the whole gate forever, with no failure and no line: measured on this Mac 2026-09-07, a
// run sat at 174 PASS 0 FAIL for twenty minutes on a `deleteConnectorSecret` that never came back,
// and there was nothing in the log to say so. A gate that hangs is worse than a gate that fails,
// because a failure names itself. 60 seconds is far longer than any of these calls needs.
const RELAY_TIMEOUT_MS = Number.parseInt(process.env.DASHBOARD_RELAY_TIMEOUT_MS ?? "60000", 10);
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
const relay = async (route, body) => { const res = await relayFetch(`${GATEWAY}${route}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}, route); return res.json(); };
// The relay holds the gateway token and adds it upstream, so a gate call needs no credential.
const gw = async (method, args = {}) => {
  const res = await relayFetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }, method);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} failed (${res.status}): ${text.slice(0, 200)}`);
  return text.length ? JSON.parse(text) : null;
};
const run = (args) => new Promise((resolve) => execFile("node", args, { maxBuffer: 16 << 20, env: process.env, cwd: repoRoot }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));
// A shell inside the box, for the one thing the relay cannot do: put the probe connector's own
// executable where the host will launch it from. Nothing else in this gate reaches past the relay.
const BOX = process.env.GROK_BOT_BOX_CONTAINER ?? "grok-bot-local-vm";
const box = (command) => new Promise((resolve) => execFile("docker", ["exec", BOX, "sh", "-lc", command], { maxBuffer: 8 << 20 }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));
// The same reach, but a program rather than a command line: the AUTOMATION-3 check has to write a
// routine's run history in the shape the host writes it, and a JS source with quotes of its own
// cannot be handed to `sh -lc` without an escaping story.
const boxNode = (source) => new Promise((resolve) => execFile("docker", ["exec", BOX, "node", "-e", source], { maxBuffer: 8 << 20 }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));
// The host settings file the teach gate flips, written the way the host wrote it (0600, flat
// string map). Same shape scripts/verify-teach.mjs uses, so the two gates cannot drift apart.
const SAND_SETTINGS = "/home/box/sand-data/sand-host-settings.json";
// readSettingsFile (source/host/sand-box-setting.ts) accepts either a flat object or
// { settings: { ... } } and PREFERS the nested one when it is there. A helper that only ever
// touched the top level would set a key the resolver never consults on an operator's nested file:
// the switch would not move, the gate would fail as if the product were broken, and the restore
// would delete a key it invented. So both helpers resolve the same container the reader picks.
const settingsContainer = "const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;";
const readSetting = async (name) => {
  const r = await box(`cat ${SAND_SETTINGS} 2>/dev/null || echo '{}'`);
  try {
    const parsed = JSON.parse(r.out);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const nested = parsed.settings;
    const source = nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed;
    return source[name];
  } catch { return undefined; }
};
const writeSetting = (name, value) => new Promise((resolve) => execFile("docker", ["exec", BOX, "node", "-e",
  `const fs=require('fs');const p=${JSON.stringify(SAND_SETTINGS)};`
  + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
  + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
  + settingsContainer
  + (value == null ? `delete c[${JSON.stringify(name)}];` : `c[${JSON.stringify(name)}]=${JSON.stringify(value)};`)
  + `fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`], (error) => resolve(error == null)));
const teachSessionDirs = async () => (await box("ls -1d /workspace/teach-sessions/teach-* 2>/dev/null || true")).out.split("\n").filter(Boolean);
// CP-11's probe: a one-file stdio MCP server with no dependencies, so the box can launch it with
// bare `node` and the host discovers exactly one tool from it.
const PROBE_CONNECTOR = "gateprobe";
const PROBE_MCP_FILE = "gate-probe-mcp.mjs";
const PROBE_MCP_SOURCE = [
  'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'let buffer = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk;',
  '  let at;',
  '  while ((at = buffer.indexOf("\\n")) >= 0) {',
  '    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);',
  '    if (!line.trim()) continue;',
  '    let msg; try { msg = JSON.parse(line); } catch { continue; }',
  '    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "gateprobe", version: "0.0.1" } } });',
  '    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "probe_ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} } }] } });',
  '    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } });',
  '    else if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: {} });',
  '  }',
  '});',
].join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 2000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
// Every gateway command the page sends, by name: GW-03's proof that a refresh reads the tail and
// never the whole transcript is a count of requests, not a DOM state.
const apiCalls = []; page.on("request", (r) => { const m = /\/api\/([A-Za-z]+)/.exec(r.url()); if (m) apiCalls.push(m[1]); });
const callsTo = (method) => apiCalls.filter((m) => m === method).length;
const userTextOf = (e) => (typeof e?.content === "string" ? e.content : Array.isArray(e?.content) ? e.content.map((c) => c?.text ?? "").join("") : "");
const clickText = async (text) => { const loc = page.getByText(text, { exact: false }).first(); const box = await loc.boundingBox(); if (!box) throw new Error(`not visible: ${text}`); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(1200); };
// An agent the operator hid lives in the roster's collapsed <details>, where it has no bounding
// box and clickText cannot reach it. Found 2026-09-07: Atera Triage is hidden on this box, so the
// GW-03 transcript arc below sometimes measured whichever agent happened to be on screen instead,
// and eight checks reported the wrong conversation's contents as missing. Open the group the way a
// person does, by its own summary, before reaching for an agent by name.
const openHiddenGroup = async () => {
  const shut = await page.evaluate(() => { const group = document.querySelector("[data-roster-hidden]"); return group != null && !group.open; });
  if (!shut) return;
  await page.click("[data-roster-hidden] > summary", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
};
// CHAT-LONG-1 / DASH-GW03, 2026-09-08. Selecting an agent by its id, and CHECKING which one is
// selected, because a text match silently measures the wrong conversation.
//
// The GW-03 arc reported "0 message rows" for a 1,578-item conversation and five checks failed
// together, and the row was written up as a product defect: the console cannot render a long
// conversation. It was not. Re-measured on grok-bot-local-vm through the same headless Chrome the
// gate uses, the host answers getConversationOutline for that agent in 420 ms and the console draws
// 190 .message-row elements in 525 ms, cold, with no page errors -- and every named agent draws,
// 190/156/34/32/26/22/22 rows, each inside 500 ms.
//
// What actually happened is the alternative the DASH-GW03 row itself named: the click landed
// somewhere else after the roster changed underneath it, and the arc then measured a different
// agent's short transcript while believing it was measuring this one. A getByText match on a name
// finds whatever is on screen; two roster cards, a search result and a details panel can all carry
// the same words. So the agent is resolved to an id through the gateway and clicked by
// data-context-id, and the selection is asserted before anything is read -- an arc that cannot say
// which agent it is looking at cannot report a defect in it.
const selectAgentByName = async (name) => {
  const id = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === name)?.id ?? null;
  if (id == null) throw new Error(`no agent called ${name} on this box`);
  await openHiddenGroup();
  const onScreen = await until(() => page.evaluate((agentId) => (document.querySelector(`.worker-card[data-context-id="${agentId}"]`) ? true : null), id), 15_000, 500);
  if (onScreen == null) throw new Error(`${name} (${id}) never appeared in the roster`);
  await page.click(`.worker-card[data-context-id="${id}"]`, { timeout: 10_000 });
  const active = await until(() => page.evaluate((agentId) => (document.querySelector(".worker-card.is-active")?.getAttribute("data-context-id") === agentId ? true : null), id), 15_000, 500);
  if (active == null) {
    const got = await page.evaluate(() => document.querySelector(".worker-card.is-active")?.querySelector(".worker-name")?.textContent?.trim() ?? "(none)");
    throw new Error(`clicked ${name} (${id}) and the active card is ${got}; this arc will not measure the wrong agent`);
  }
  await page.waitForTimeout(1200);
  return id;
};
// MARKET-1: the Global capabilities panel is the Marketplace now, and the provider and chat
// listener cards moved out of it into Settings. Two openers, so every check below says which
// surface it means rather than clicking a word that appears on both.
const openMarketplace = async () => {
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({
    open: document.getElementById("panel-dialog")?.open === true,
    title: document.getElementById("panel-title")?.textContent?.trim() ?? "",
    buttons: document.querySelectorAll('[data-capability="marketplace"]').length,
  }));
  await page.click('[data-capability="marketplace"]'); await page.waitForTimeout(1400);
  // The panel's markup survives its own close, so every read below this line answers whether or
  // not the dialog is on screen and only a CLICK notices. That turned a panel that did not open
  // into a thirty-second timeout on whichever control was clicked first, reported against that
  // control. Wait for the dialog itself, and say so in its own words when it never came up.
  const opened = await until(() => page.evaluate(() =>
    (document.getElementById("panel-dialog")?.open === true ? true : null)), 20_000, 250);
  if (!opened) {
    const after = await page.evaluate(() => ({
      title: document.getElementById("panel-title")?.textContent?.trim() ?? "",
      tabs: document.querySelectorAll("[data-marketplace-tabs]").length,
      dialogs: [...document.querySelectorAll("dialog")].filter((d) => d.open).map((d) => d.id || d.className),
    }));
    throw new Error(`the Marketplace panel did not open: #panel-dialog is closed. Before the click it was `
      + `${before.open ? `open on "${before.title}"` : "closed"} with ${before.buttons} marketplace button(s); `
      + `after it holds "${after.title}" (${after.tabs} tab strip) and the open dialogs are ${JSON.stringify(after.dialogs)}`);
  }
  // The panel reads the catalog through the gateway when it opens and says so while it is reading
  // (MR-37). The fixed wait above was a latency measurement of the box: on a loaded one the
  // coverage checks read the panel mid-read and reported every card in the catalog missing. Wait
  // for that read to have ANSWERED -- not for any particular answer -- so a panel that genuinely
  // draws nothing still fails the checks below on its own numbers.
  await until(() => page.evaluate(() => (document.querySelector("[data-marketplace-loading]") == null ? true : null)), 30_000, 500);
};
const openSettingsPanel = async () => {
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  await page.click("#settings-button"); await page.waitForTimeout(1400);
};
// A nav click by id, not by text: the sidebar scrolls, and a click at a stale coordinate lands on
// the dialog backdrop, which closes the panel instead of selecting the card. Retried once through
// a reopened panel. A run in this wave hit a 30s
// "element is not visible" on a button the same click reaches in isolation, so the failure is
// transient panel state rather than the card; the diagnostic says which ancestor was hiding it
// instead of leaving the next reader with a bare timeout.
const pluginNavState = (id) => page.evaluate((sel) => {
  const el = document.querySelector(`[data-plugin-id="${sel}"]`);
  if (!el) return { found: false, dialogOpen: document.getElementById("panel-dialog")?.open ?? null };
  const rect = el.getBoundingClientRect();
  const hidden = [];
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") hidden.push(`${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(" ")[0]}` : ""}:${cs.display}/${cs.visibility}`);
  }
  return { found: true, w: Math.round(rect.width), h: Math.round(rect.height), hidden, dialogOpen: document.getElementById("panel-dialog")?.open ?? null };
}, id);
const pickPlugin = async (id, reopen = openMarketplace) => {
  try {
    await page.click(`[data-plugin-id="${id}"]`, { timeout: 12_000 });
  } catch (error) {
    console.log(`  INFO  ${id} not clickable on the first try: ${JSON.stringify(await pluginNavState(id))}`);
    await reopen();
    await page.click(`[data-plugin-id="${id}"]`, { timeout: 12_000 });
  }
  await page.waitForTimeout(1200);
};
const domText = () => page.evaluate(() => document.documentElement.outerHTML);
// The Agent details panel fills two rows asynchronously from the host. The screen row waits on
// ensureForeverBox, which allocates a display on a cold box -- the adapter's own note says about
// 13s, and a fixed 6s wait here failed on the first gate run after a container restart. Poll for
// the resolved answer instead, and treat the placeholder as "not yet", so the assertion cannot
// pass on the sentence that only says it is asking.
const settled = (selector, placeholder, ms = 25_000) => until(async () => {
  const t = await page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? "", selector);
  return t && !placeholder.test(t) ? t : null;
}, ms, 1500);
const noDemoStrings = async (where) => {
  const html = await domText();
  const hit = FORBIDDEN.filter((s) => html.includes(s));
  check(hit.length === 0, `no prototype copy in the DOM · ${where}`, hit.join(", "));
};
// The catalog's own live marker names the row to restore; /model alone does not carry the row id.
const startCatalog = await relay("/endpoints").catch(() => null);
const previousRow = startCatalog?.endpoints?.find((e) => e.baseUrl === startCatalog?.live?.baseUrl && e.model === startCatalog?.live?.model) ?? null;
let probeAgentId = null;
// CP-11: set while the gate's own connector is in connectors.json, so the finally block can take
// it back out if an assertion threw between the write and the removal.
let probeConnectorAdded = false;
// MARKET-1: set while the catalog's tinyfish entry the Add check wrote is still in connectors.json,
// so the finally block takes it back out if an assertion threw between the Add and the Uninstall.
let tinyfishAdded = false;
// Set once the key form has stored a throwaway value for that connector, so the finally block can
// take it back out of the host's connector-secret store.
let probeSecretStored = false;
// The GW-01 Duplicate check's copy, deleted through the panel; swept here if that step did not.
let copyAgentId = null;
// The workflow library is GLOBAL on the box (workflow-store.ts GlobalWorkflowLibrary; per-agent
// state is only the enablement), so a skill this gate imports or ports through the probe agent
// outlives the probe and shows up on every production agent. Snapshot the library once the probe
// exists and delete everything the run added before the probe itself goes.
let libraryBefore = null;
// BOTS-1: the agent Import Bot minted, and the box-wide workflow library as it stood before that
// import. Both are set while the imported agent exists, so an assertion that throws between the
// click and the delete still leaves the box the way the run found it.
let botAgentId = null;
let botLibraryBefore = null;
// A SIGTERM never reaches the finally block -- Node's default handler ends the process outright --
// and this gate is run under `timeout`, which sends exactly that. The imported agent is a real
// agent on a shared box, so it is swept on the way out. A sweep that cannot finish in two seconds
// is abandoned rather than left hanging a run that has already been told to stop.
let sweepingOnSignal = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (sweepingOnSignal) process.exit(143);
    sweepingOnSignal = true;
    const swept = botAgentId ? gw("deleteAgent", { id: botAgentId }).catch(() => {}) : Promise.resolve();
    void Promise.race([swept, new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => process.exit(143));
  });
}
// --teach flips SAND_TEACH to prove the refusal path; the finally puts the box back.
let teachSettingBefore;
let teachSettingTouched = false;
let teachSessionDir = null;
// Every session directory this pass created, so a run that records more than once still leaves
// /workspace/teach-sessions the way it found it.
const teachDirsMade = new Set();
const libraryIds = async (id) => ((await gw("getAgentWorkflows", { id })) ?? []).filter((w) => w.source !== "automation").map((w) => w.id);
try {
  if (OFFLINE) {
    // index.html falls back to the demo factory whenever hydration fails, and that factory really
    // does discard the value it is handed. Every sentence on that path has to say so: this is the
    // one place where a "connected, stored" toast would be a lie in the other direction. Blocking
    // the relay's own routes in the browser reaches it without stopping the relay.
    for (const route of ["**/api/**", "**/connectors", "**/subscriptions", "**/endpoints", "**/model", "**/events"]) await page.route(route, (r) => r.abort());
    await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(3500);
    check(await page.evaluate(() => window.__machineRoomLive === false), "the page falls back to the offline demo adapter when the gateway is unreachable");

    // -- AVATAR-1 and the brand, with no host at all. The crew is drawn from the roster the demo
    // factory holds, so none of this depends on the box being reachable.
    const brand = await page.evaluate(() => ({
      cards: Array.from(document.querySelectorAll(".worker-card:not(.room-card)")).map((el) => ({
        name: el.querySelector(".worker-name")?.textContent?.trim() ?? "",
        character: el.querySelector("[data-titan-character]")?.dataset.titanCharacter ?? null,
        face: Boolean(el.querySelector("titan-mascot")) || Boolean(el.querySelector(".titan-avatar img")),
      })),
      lockup: document.querySelector(".window-identity .window-lockup")?.getAttribute("src") ?? null,
      lockupBox: (() => { const el = document.querySelector(".window-lockup"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
      eyebrow: document.querySelector(".window-identity .window-eyebrow")?.textContent?.trim() ?? "",
      favicon: document.querySelector("link[rel=icon]")?.getAttribute("href") ?? "",
      title: document.title,
      background: document.documentElement.dataset.bg ?? "",
    }));
    check(brand.cards.length > 0 && brand.cards.every((c) => c.character && c.face), "every roster card holds a crew member, canvas or still, with no gateway", brand.cards.map((c) => `${c.name}:${c.character ?? "none"}`).join(", "));
    check(brand.cards[0]?.character === "Titan", "and the first agent of the instance is Titan", brand.cards[0]?.character ?? "no card");
    check(brand.lockup === "assets/titanium-bot-logo.svg" && brand.lockupBox > 12, "the window bar carries the Titanium Bot lockup at the bar's own height", `${brand.lockup ?? "no mark"} at ${brand.lockupBox}px`);
    check(brand.eyebrow === "Machine Room" && /Machine Room/.test(brand.title), "with Machine Room kept as the eyebrow and the page title", `"${brand.eyebrow}" / "${brand.title}"`);
    check(brand.favicon === "assets/favicon.svg", "and the tab icon is the product mark rather than the empty data: URI", brand.favicon || "none");
    check(brand.background === "titan-nebula", "a browser with nothing stored opens on Titan Nebula", brand.background || "the handoff's own plate");
    // prefers-reduced-motion: the crew becomes stills, no canvas runs. Measured by asking the
    // browser for the preference and loading the roster again, then putting it back.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".worker-card", { timeout: 30000 }).catch(() => {});
    const reduced = await page.evaluate(() => ({
      canvases: document.querySelectorAll(".worker-card titan-mascot, .worker-card canvas").length,
      stills: document.querySelectorAll(".worker-card img[src*='characters/']").length,
      cards: document.querySelectorAll(".worker-card").length,
    }));
    check(reduced.cards > 0 && reduced.canvases === 0, "under prefers-reduced-motion no roster face runs a canvas", `${reduced.canvases} canvases on ${reduced.cards} cards`);
    check(reduced.stills >= reduced.cards, "and every card shows its character as a still", `${reduced.stills} stills for ${reduced.cards} cards`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".worker-card", { timeout: 30000 }).catch(() => {});
    await openMarketplace();
    const ids = await page.$$eval("[data-plugin-id]", (els) => els.map((e) => e.dataset.pluginId));
    let hint = "";
    for (const id of ids) {
      await pickPlugin(id).catch(() => {});
      // Scoped to the open plugin panel, not the page: the transcript now carries a masked
      // credential card of its own (SECRET-1), and a page-wide `input[type=password]` matched it
      // for every plugin, including the ones with no secret form and therefore no submit button.
      if ((await page.$$(".plugin-detail input[type=password]")).length === 0) continue;
      hint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
      await page.fill(".plugin-detail input[type=password]", "not-a-real-key");
      await page.click(".plugin-detail button[type=submit]"); await page.waitForTimeout(1200);
      break;
    }
    const toast = await page.evaluate(() => document.body.innerText.split("\n").filter((l) => /connected|discard/i.test(l)).join(" | "));
    check(/discard/i.test(hint) && !/relay/i.test(hint), "the offline secret form says the value is discarded, not that the relay stored it", hint.slice(0, 120));
    check(/discard/i.test(toast), "and the offline toast says the same instead of a bare 'connected'", toast.slice(0, 130));
    // Writes the demo factory does not implement must not be drawn as live controls.
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    await page.click("#room-menu").catch(() => {}); await page.waitForTimeout(1200);
    check((await page.$$("[data-save-role]")).length === 0, "no Role Save button on an adapter with no setRole");
    check((await page.$$("[data-clear-memories]")).length === 0, "no Forget-all button on an adapter with no clearMemories");

    // -- EVID-UX-1: the claim-provenance verdict reads as a note on the reply, not as an error.
    // The offline conversation carries both tones (one evidenced reply, one unsupported), so this
    // measures the presentation with no gateway and no model turn.
    await page.keyboard.press("Escape"); await page.waitForTimeout(600);
    const chipState = await page.evaluate(() => {
      const chips = [...document.querySelectorAll(".evidence-chip")];
      return {
        verdicts: chips.map((chip) => chip.dataset.verdict ?? ""),
        unsupported: chips.filter((chip) => chip.dataset.verdict === "unsupported").map((chip) => chip.textContent.trim()),
        // A chip wider than its own box means the sentence spilled past the message column.
        overflowing: chips.filter((chip) => chip.scrollWidth > chip.clientWidth).map((chip) => chip.textContent.trim()),
        outsideRow: chips.filter((chip) => Math.round(chip.getBoundingClientRect().right) > Math.round(chip.closest(".message-row").getBoundingClientRect().right) + 1).length,
        inOwnRow: chips.every((chip) => chip.closest(".message-row") && !chip.closest(".message-row").classList.contains("is-system")),
        titled: chips.every((chip) => /compares the names, paths and links/.test(chip.getAttribute("title") ?? "")),
        opens: chips.every((chip) => chip.tagName === "BUTTON"),
        systemLines: [...document.querySelectorAll(".message-row")].map((row) => row.textContent.trim()).filter((text) => text.startsWith("Evidence:")),
      };
    });
    check(chipState.verdicts.includes("evidenced") && chipState.verdicts.includes("unsupported"), "the verdict is a chip in the reply's own row, in both of its tones", chipState.verdicts.join(", ") || "no chip on screen");
    check(chipState.inOwnRow && chipState.opens, "every chip sits in a reply row and is a button that opens Claim provenance");
    check(chipState.titled, "and each one says on hover what the check compares");
    check(chipState.systemLines.length === 0, "no message on the page is a synthesized \"Evidence:\" system line", chipState.systemLines.slice(0, 2).join(" | "));
    check(chipState.unsupported.length > 0 && chipState.unsupported.every((text) => !/http/i.test(text)), "an unsupported chip names no URL: the missing token stays in the disclosure", chipState.unsupported.join(" | "));
    check(chipState.overflowing.length === 0 && chipState.outsideRow === 0, "and no chip overflows itself or bleeds past its message row", chipState.overflowing.slice(0, 2).join(" | ") || `${chipState.verdicts.length} chip(s) inside their rows`);

    // The number on an evidenced chip is the attested tool results the verdict was decided
    // against, never the action receipts: the two lists differ, and the earlier chip counted the
    // wrong one. One click behind it the panel must not print the raw verdict word either, or the
    // "Evidence: unsupported" line the chip removed is simply one click further in.
    const evidencedChip = (await page.$$('.evidence-chip[data-verdict="evidenced"]')).at(0) ?? null;
    if (!evidencedChip) {
      check(false, "an evidenced chip is on screen to open");
    } else {
      const chipText = await evidencedChip.evaluate((el) => el.textContent.trim());
      await evidencedChip.scrollIntoViewIfNeeded();
      await evidencedChip.click();
      const panelText = await until(async () => {
        const seen = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent?.replace(/\s+/g, " ") ?? "");
        return seen && !/Reading the receipts from the host/.test(seen) ? seen : null;
      }, 20_000, 500) ?? "";
      const claimed = Number((/Backed by (\d+) tool result/.exec(chipText) ?? [])[1] ?? -1);
      const attested = Number((/(\d+) attestation/.exec(panelText) ?? [])[1] ?? -2);
      const receipted = Number((/(\d+) receipt/.exec(panelText) ?? [])[1] ?? -3);
      check(claimed >= 0 && claimed === attested, "the evidenced chip counts the attested tool results the panel lists", `chip ${claimed}, panel ${attested} attestation(s) and ${receipted} receipt(s)`);
      check(claimed !== receipted, "and that count is not the action-receipt count wearing the tool-result label", `${claimed} vs ${receipted}`);
      check(!/\b(evidenced|unsupported|unverified|undecidable)\b/.test(panelText), "the panel behind the chip prints no raw verdict word", panelText.slice(0, 140));
      await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    }

    // SECRET-1: the inline credential card, offline. The copy has to be the product's -- the
    // description line under the title, the custody hint under the masked field, and "Save
    // securely" on the button -- and after a submit the value must survive NOWHERE on the page:
    // not in the input, not in the markup, not in the collapsed card. The probe value is generated
    // here, is not a credential, and is never printed by this script.
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    const secretButton = await page.$("[data-submit-secret]");
    if (!secretButton) {
      check(false, "the offline conversation carries a masked credential card");
    } else {
      const secretId = await secretButton.evaluate((el) => el.dataset.submitSecret);
      const beforeSecret = await page.evaluate((id) => {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        return {
          card: row?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          type: row?.querySelector("input[data-secret-input]")?.getAttribute("type") ?? "",
          hint: row?.querySelector(".secret-hint")?.textContent?.trim() ?? "",
          button: row?.querySelector("[data-submit-secret]")?.textContent?.trim() ?? "",
        };
      }, secretId);
      check(beforeSecret.type === "password", "the credential field is a masked password input", beforeSecret.type || "no input on the card");
      // SECRET-1: the seeded card is a `shell` request (platform "shell", field TITAN_JOB_TOKEN),
      // and the custody line for that destination is NOT the connector one. The generic hint says
      // "never shown to your agent" while this route's whole purpose is to put the value in the
      // shell that agent runs commands in, so pinning the generic line here would pin the lie.
      check(beforeSecret.hint === "Stored securely and never shown in this chat. It becomes $TITAN_JOB_TOKEN in this agent's shell, so commands it runs can read it.", "the hint under a shell-destination field says the value reaches that agent's shell", beforeSecret.hint || "no hint");
      check(!/never shown to your agent/.test(beforeSecret.hint), "and does not carry the connector card's custody promise", beforeSecret.hint || "no hint");
      check(beforeSecret.button === "Save securely", "the button says Save securely", beforeSecret.button || "no button");
      check(/Never share it in chat/.test(beforeSecret.card) && /TITAN_JOB_TOKEN/.test(beforeSecret.card), "the card carries the request's own description line under its title", beforeSecret.card.slice(0, 160));

      const SECRET_PROBE = `offline-secret-${Math.random().toString(36).slice(2, 12)}`;
      await page.fill(`[data-secret-input="${secretId}"]`, SECRET_PROBE);
      await page.click(`[data-submit-secret="${secretId}"]`);
      await page.waitForTimeout(1500);
      const afterSecret = await page.evaluate(([id, probe]) => {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        return {
          card: row?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          pill: row?.querySelector(".status-pill.success")?.textContent?.trim() ?? "",
          inputs: row ? row.querySelectorAll("input").length : -1,
          inMarkup: document.documentElement.innerHTML.includes(probe),
          inValues: [...document.querySelectorAll("input")].some((el) => el.value.includes(probe)),
          inText: document.body.innerText.includes(probe),
        };
      }, [secretId, SECRET_PROBE]);
      check(/Saved securely and kept private\./.test(afterSecret.card), 'a submitted card collapses to "Saved securely and kept private."', afterSecret.card.slice(0, 160));
      check(/Saved/.test(afterSecret.pill), "with a green Saved pill beside it", afterSecret.pill || "no success pill");
      check(afterSecret.inputs === 0, "and the masked field is gone from the card", `${afterSecret.inputs} input(s) left on the card`);
      check(!afterSecret.inMarkup && !afterSecret.inValues && !afterSecret.inText, "no part of the submitted value survives anywhere on the page");
    }

    // JOBBUS-3: the Job bus card in both of its states, with no relay and no gateway to answer.
    // The offline adapter's bus starts off, with no token and therefore no jobs; generating one
    // there mints a value that exists in the tab and nowhere else and arms the switch, which is
    // §10.7's rule, so the card can be read in the configured state as well. What is being
    // checked is the card, not the demo: the enabled switch and its line, the token state, the
    // base URL, the once-shown token beside its warning, the curl example carrying a placeholder
    // rather than a token, the worker mapping as a type against an agent picked from the roster,
    // the repos and connectors allowlists, the three limits, and the two rows with the pill
    // classes the contract fixes for done and needs_human.
    await openSettingsPanel();
    const jobBus = () => page.evaluate(() => {
      const root = document.querySelector("[data-job-bus]");
      if (!root) return null;
      const text = (selector) => root.querySelector(selector)?.textContent?.trim() ?? "";
      const value = (selector) => root.querySelector(selector)?.value ?? "";
      const rows = Array.from(root.querySelectorAll("[data-job-bus-row]")).map((tr) => ({
        id: tr.getAttribute("data-job-bus-row"),
        pill: tr.querySelector(".status-pill")?.className ?? "",
        status: tr.querySelector(".status-pill")?.textContent?.trim() ?? "",
        worker: tr.querySelector(".job-bus-worker")?.textContent?.trim() ?? "",
        from: tr.querySelector(".job-bus-worker")?.getAttribute("title") ?? "",
        line: tr.querySelector(".job-bus-line")?.textContent?.trim() ?? "",
      }));
      return {
        state: text("[data-job-bus-state]"), pill: text("[data-job-bus-pill]"),
        base: text("[data-job-bus-base]"), curl: text("[data-job-bus-curl]"),
        enabled: root.querySelector("[data-job-bus-enabled]")?.getAttribute("aria-pressed") ?? "",
        enabledNote: text("[data-job-bus-enabled-note]"),
        mintedHidden: root.querySelector("[data-job-bus-minted]")?.hidden !== false,
        minted: root.querySelector("[data-job-bus-minted-value]")?.value ?? "",
        warning: root.querySelector("[data-job-bus-minted] .field-hint")?.textContent?.trim() ?? "",
        // The agent half is a select now: its value is the id that gets saved, its label is the
        // name the operator reads. Both are carried out so the gate can hold them apart.
        workers: Array.from(root.querySelectorAll("[data-job-bus-worker]")).map((row) => {
          const select = row.querySelector("[data-job-bus-worker-agent]");
          return {
            type: row.querySelector("[data-job-bus-worker-type]")?.value ?? "",
            agentId: select?.value ?? "",
            agentLabel: select?.selectedOptions?.[0]?.textContent?.trim() ?? "",
            tag: (select?.tagName ?? "").toLowerCase(),
            choices: Array.from(select?.options ?? []).length,
          };
        }),
        repos: Array.from(root.querySelectorAll("[data-job-bus-repo-value]")).map((field) => field.value),
        connectors: Array.from(root.querySelectorAll("[data-job-bus-connector-value]")).map((field) => field.value),
        limits: {
          queueTimeoutMin: value("[data-job-bus-queue-timeout]"),
          timeoutMin: value("[data-job-bus-timeout]"),
          maxOpen: value("[data-job-bus-max-open]"),
        },
        rows,
        // The card must not push the dialog wider than the dialog: this is the MR-27 bleed.
        overflows: root.scrollWidth > root.clientWidth + 1,
      };
    });
    const unconfigured = await jobBus();
    check(unconfigured != null, "the Job bus card is on Settings");
    check(/not configured/i.test(unconfigured?.pill ?? ""), "unconfigured, the pill says so", unconfigured?.pill ?? "");
    check(/401/.test(unconfigured?.state ?? ""), "and the line says what a caller gets instead", (unconfigured?.state ?? "").slice(0, 110));
    // §10.7: the bus is off until somebody turns it on, and the card has to open on that.
    check(unconfigured?.enabled === "false", "the Enabled switch is off before the operator arms it", unconfigured?.enabled ?? "absent");
    check(/503/.test(unconfigured?.enabledNote ?? "") && /disabled/i.test(unconfigured?.enabledNote ?? ""),
      "and its line says a create is refused with 503 while it is off", (unconfigured?.enabledNote ?? "").slice(0, 110));
    check((unconfigured?.base ?? "").endsWith("/v1"), "the base URL is the /v1 root", unconfigured?.base ?? "");
    check(unconfigured?.mintedHidden === true, "no token field before one is minted");
    check((unconfigured?.rows ?? []).length === 0, "and no jobs behind a bus nobody can call", `${(unconfigured?.rows ?? []).length} row(s)`);
    check(unconfigured?.overflows === false, "the card fits its panel unconfigured");

    await page.click("[data-job-bus-generate]"); await page.waitForTimeout(1200);
    const configured = await jobBus();
    check(/configured/i.test(configured?.pill ?? "") && !/not configured/i.test(configured?.pill ?? ""),
      "after Generate the card reads configured", configured?.pill ?? "");
    check(configured?.enabled === "true", "and generating a token turned the bus on, which is §10.7's rule", configured?.enabled ?? "absent");
    check(configured?.mintedHidden === false && /^[0-9a-f]{48}$/.test(configured?.minted ?? ""),
      "the minted token is shown once in a copyable field", `${(configured?.minted ?? "").length} chars`);
    check(/only time it is shown/i.test(configured?.warning ?? ""), "beside the one-line warning", (configured?.warning ?? "").slice(0, 80));
    check(/\$TITAN_JOB_TOKEN/.test(configured?.curl ?? "") && !(configured?.curl ?? "").includes(configured?.minted ?? "x"),
      "the curl example carries a placeholder, never the token", configured?.curl ?? "");
    // §10.2: the mapping stores an agent id and the operator picks it off the roster by name.
    const mapped = (configured?.workers ?? []).find((row) => row.type === "nextgen.chapter");
    check(mapped != null && mapped.tag === "select" && mapped.choices > 1,
      "the worker mapping picks its agent from the roster rather than taking a typed name",
      mapped ? `${mapped.tag} with ${mapped.choices} choice(s)` : "no nextgen.chapter row");
    check(mapped != null && mapped.agentId === "clientsync" && mapped.agentLabel === "ClientSync Tester",
      "and it holds the agent id while showing the agent's name",
      mapped ? `${mapped.agentId} shown as ${mapped.agentLabel}` : "absent");
    check((configured?.repos ?? []).includes("webdevtodayjason/nextgen-training"),
      "the repos allowlist is drawn as editable rows", JSON.stringify(configured?.repos ?? []));
    check((configured?.connectors ?? []).includes("github"),
      "so is the list of connectors the per-job clone keeps", JSON.stringify(configured?.connectors ?? []));
    check(configured?.limits?.queueTimeoutMin === "60" && configured?.limits?.timeoutMin === "120" && configured?.limits?.maxOpen === "20",
      "the two timeouts and maxOpen are numbers read off the settings", JSON.stringify(configured?.limits ?? {}));
    const done = (configured?.rows ?? []).find((row) => /done/.test(row.status));
    const blocked = (configured?.rows ?? []).find((row) => /needs.human/.test(row.status));
    check((configured?.rows ?? []).length === 2, "two jobs in the table", `${(configured?.rows ?? []).length} row(s)`);
    check(done != null && /status-pill success/.test(done.pill) && done.line.length > 0,
      "the done job is good and carries its one-line result", done ? `${done.pill} · ${done.line.slice(0, 60)}` : "absent");
    check(blocked != null && /status-pill attention/.test(blocked.pill) && /github_auth/.test(blocked.line),
      "the needs_human job is attention and carries what a person must do", blocked ? `${blocked.pill} · ${blocked.line.slice(0, 60)}` : "absent");
    // §10.2 again: the Worker column is the per-job clone, and the agent it came from is on the
    // cell's title, because the clone is deleted the moment the job ends.
    check(done != null && / · job /.test(done.worker) && /cloned from clientsync/.test(done.from),
      "the Worker column names the per-job clone and says which agent it was cloned from",
      done ? `${done.worker} (${done.from})` : "absent");

    // Adding and removing a row is the whole point of an editable list, and the empty-list hint
    // must not survive an add. Nothing is saved: the offline adapter is the only thing behind it.
    await page.click("[data-job-bus-repo-add]"); await page.waitForTimeout(300);
    const added = await jobBus();
    check((added?.repos ?? []).length === (configured?.repos ?? []).length + 1,
      "Add a repository appends an empty row", `${(configured?.repos ?? []).length} -> ${(added?.repos ?? []).length}`);
    await page.click("[data-job-bus-repo] [data-job-bus-row-remove]"); await page.waitForTimeout(300);
    const removed = await jobBus();
    check((removed?.repos ?? []).length === (added?.repos ?? []).length - 1,
      "and Remove takes one away", `${(added?.repos ?? []).length} -> ${(removed?.repos ?? []).length}`);
    check(configured?.overflows === false, "and the card still fits its panel with the table on it");

    // -- ONBOARD-1: the first-run dialog, with no host at all. The demo adapter reports a box that
    // has never been set up only when it is asked to (?onboarding=1), so the rest of this arm
    // opens on the console it always did. What is checked here is the dialog itself: it is modal
    // and sits under the window bar with the chat behind it, Titan's own face is in it and it is
    // large, the five questions he asks are drawn and none of them is answered yet, his opening
    // line is in the dialog's own transcript, an answer typed into the dialog's own composer lands
    // there as well, and Skip for now closes it into the normal console. No model turn is spent:
    // the demo's reply is the demo's.
    await page.goto(`${GATEWAY}/?onboarding=1`, { waitUntil: "load" });
    await page.waitForSelector("#onboarding-dialog[open]", { timeout: 20000 }).catch(() => {});
    const setup = await page.evaluate(() => {
      const dialog = document.getElementById("onboarding-dialog");
      if (!dialog || !dialog.open) return null;
      const box = dialog.getBoundingClientRect();
      const bar = document.querySelector(".window-bar")?.getBoundingClientRect() ?? { bottom: 0 };
      const face = dialog.querySelector(".onboarding-face");
      const faceBox = face ? face.getBoundingClientRect() : null;
      const steps = Array.from(dialog.querySelectorAll("[data-onboarding-step]")).map((li) => ({
        field: li.dataset.onboardingStep,
        label: li.textContent.replace(/\s+/g, " ").trim(),
        done: li.classList.contains("is-done"),
      }));
      return {
        modal: typeof dialog.matches === "function" && dialog.matches(":modal"),
        below: Math.round(box.top) >= Math.round(bar.bottom) - 1,
        wide: box.width > Math.min(700, window.innerWidth - 120),
        chatBehind: Boolean(document.getElementById("transcript")),
        face: Boolean(face),
        character: face?.dataset.titanCharacter ?? "",
        mood: face?.dataset.titanMood ?? "",
        drawn: Boolean(face && (face.querySelector("titan-mascot") || face.querySelector("img"))),
        faceSize: faceBox ? Math.round(Math.min(faceBox.width, faceBox.height)) : 0,
        steps,
        counter: dialog.querySelector("[data-onboarding-count]")?.textContent?.trim() ?? "",
        skip: dialog.querySelector("[data-onboarding-skip]")?.textContent?.trim() ?? "",
        composer: Boolean(dialog.querySelector("[data-onboarding-composer] textarea")),
        // The box to answer him in has to be reachable: a long conversation must scroll inside the
        // transcript rather than push the composer out of the dialog and off the screen.
        composerInside: (() => {
          const form = dialog.querySelector("[data-onboarding-composer]");
          if (!form) return false;
          const rect = form.getBoundingClientRect();
          return Math.round(rect.bottom) <= Math.round(box.bottom) + 1
            && Math.round(rect.top) >= Math.round(box.top) - 1
            && Math.round(rect.bottom) <= window.innerHeight + 1;
        })(),
        opening: dialog.querySelector("#onboarding-transcript")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        openingRows: dialog.querySelectorAll("#onboarding-transcript .message-row").length,
        // The dialog must not push itself wider than its own frame.
        overflows: dialog.scrollWidth > dialog.clientWidth + 1,
      };
    });
    if (setup == null) {
      check(false, "the first-run dialog opens on a box that reports setup is not done");
      notReached("no dialog on screen",
        "the first-run dialog is modal, under the window bar, with the chat still behind it",
        "Titan's own face is in it, live and large",
        "the five questions are drawn, none of them answered yet",
        "the counter says none of the five is answered",
        "Skip for now is the way out",
        "and the box to answer him in sits inside the dialog, on the screen",
        "Titan opens the conversation himself inside the dialog",
        "an answer typed in the dialog lands in the dialog's own conversation",
        "and the box is cleared for the next one",
        "and Titan looks pleased the moment an answer is given",
        "Skip for now closes the dialog into the normal console");
    } else {
      check(true, "the first-run dialog opens on a box that reports setup is not done");
      check(setup.modal && setup.below && setup.wide && setup.chatBehind && !setup.overflows,
        "the first-run dialog is modal, under the window bar, with the chat still behind it",
        `modal ${setup.modal}, below the bar ${setup.below}, full width ${setup.wide}, chat behind ${setup.chatBehind}`);
      check(setup.face && setup.drawn && setup.character === "Titan" && setup.faceSize >= 96,
        "Titan's own face is in it, live and large", `${setup.character || "no character"} at ${setup.faceSize}px, mood ${setup.mood || "none"}`);
      const fields = setup.steps.map((step) => step.field).join(",");
      check(fields === "name,location,business,ownsBusiness,workingStyle",
        "the five questions are drawn, none of them answered yet", `${fields || "no steps"} · ${setup.steps.filter((s) => s.done).length} answered`);
      check(setup.steps.length === 5 && setup.steps.every((step) => !step.done && /[a-z]/.test(step.label)),
        "and each one is a plain-words label rather than a field name", setup.steps.map((s) => s.label).join(" | "));
      check(/^0 of 5 answered$/.test(setup.counter), "the counter says none of the five is answered", setup.counter || "no counter");
      check(setup.skip === "Skip for now" && setup.composer, "Skip for now is the way out", `${setup.skip || "no button"}, composer ${setup.composer}`);
      check(setup.composerInside, "and the box to answer him in sits inside the dialog, on the screen", `inside ${setup.composerInside}`);
      // The fixture opens on a conversation that has not started, so his opening line is the only
      // thing in the dialog. One row, and it is his: the console asked for it, because the host's
      // own kickstart never fires on a fresh box's first agent.
      check(setup.openingRows === 1 && /I am Titan, your AI lead/.test(setup.opening),
        "Titan opens the conversation himself inside the dialog", `${setup.openingRows} row(s): ${setup.opening.slice(0, 90) || "an empty transcript"}`);

      await page.fill("#onboarding-input", "Jason");
      await page.click("[data-onboarding-composer] button[type=submit]");
      await page.waitForTimeout(900);
      const answered = await page.evaluate(() => {
        const dialog = document.getElementById("onboarding-dialog");
        return {
          rows: Array.from(dialog.querySelectorAll("#onboarding-transcript .message-row")).map((row) => row.textContent.replace(/\s+/g, " ").trim()),
          mine: dialog.querySelectorAll("#onboarding-transcript .message-row.is-user").length,
          mood: dialog.querySelector(".onboarding-face")?.dataset.titanMood ?? "",
          field: dialog.querySelector("#onboarding-input")?.value ?? "",
        };
      });
      check(answered.mine > 0 && answered.rows.some((row) => /Jason/.test(row)),
        "an answer typed in the dialog lands in the dialog's own conversation", `${answered.mine} of mine in ${answered.rows.length} row(s)`);
      check(answered.field === "", "and the box is cleared for the next one", answered.field || "empty");
      check(answered.mood === "excited", "and Titan looks pleased the moment an answer is given", answered.mood || "no mood");

      await page.click("[data-onboarding-skip]");
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => ({
        open: document.getElementById("onboarding-dialog")?.open === true,
        cards: document.querySelectorAll(".worker-card").length,
        composer: Boolean(document.getElementById("message-input")),
      }));
      check(!after.open && after.cards > 0 && after.composer,
        "Skip for now closes the dialog into the normal console", `open ${after.open}, ${after.cards} roster card(s)`);
    }

    // -- AGENTS-CAP-2, offline: the cap is drawn from the roster on the page, not from a host.
    // GATE-15: no literal. There is no box in this mode, so the number the page falls back to is
    // AGENT_CAP_DEFAULT in app.js, and the gate reads it out of the source it is testing rather
    // than carrying a second copy that goes stale the next time the default moves. The live legs
    // further down ask the box instead, which is the number that actually refuses.
    const appSource = await readFile(path.join(repoRoot, "ui", "machine-room", "app.js"), "utf8");
    const declared = Number(/AGENT_CAP_DEFAULT\s*=\s*(\d+)/.exec(appSource)?.[1]);
    const capCounts = await page.evaluate(() => ({
      header: document.querySelector("[data-agent-count]")?.textContent?.trim() ?? "",
      add: document.querySelector('[data-capability="add"] [data-add-count]')?.textContent?.trim() ?? "",
      bots: document.querySelectorAll(".worker-card:not(.room-card)").length,
    }));
    check(Number.isInteger(declared) && declared > 0,
      "app.js declares the ceiling the offline console falls back to", `AGENT_CAP_DEFAULT ${declared || "not found"}`);
    check(capCounts.header === `${capCounts.bots} / ${declared} bots`,
      "the roster header counts this box's bots against that ceiling", `${capCounts.header || "empty"} beside ${capCounts.bots} bot card(s)`);
    check(capCounts.add === `${Math.max(0, capCounts.bots - 1)} of ${declared - 1}`,
      "and the Add button says how many of the seats beside Titan are taken", capCounts.add || "empty");
  } else if (LEAKS) {
    await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(4000);
    const { storedSecrets } = await import(path.join(repoRoot, "ui", "subscriptions.mjs"));
    const secrets = await storedSecrets();
    await openSettingsPanel();
    for (const id of ["sub:zai", "sub:codex"]) await pickPlugin(id, openSettingsPanel).catch(() => {});
    await openMarketplace();
    await pickPlugin("mcp:localfiles").catch(() => {});
    const dom = await page.evaluate(() => document.documentElement.outerHTML + " " + Array.from(document.querySelectorAll("input")).map((i) => i.value).join(" "));
    check(!secrets.some((s) => dom.includes(s)), `no adopted secret in the dashboard DOM (${secrets.length} held)`);
    // The connector card is built from connectors.json, which ui/server.mjs itself calls a 0600
    // file carrying connector tokens in plaintext. Its argv and env must not reach the page.
    const spec = await relay("/connectors").then((c) => c?.mcpServers ?? {}).catch(() => ({}));
    const specValues = Object.values(spec).flatMap((s) => [...(s?.args ?? []), ...Object.values(s?.env ?? {})]).map(String).filter((v) => v.length > 2);
    const blurbs = await page.$$eval(".plugin-detail .plugin-hero-copy p, .plugin-nav-button small", (els) => els.map((e) => e.textContent).join(" "));
    check(!specValues.some((v) => blurbs.includes(v)), `no connector argv or env value in the dashboard DOM (${specValues.length} checked)`, specValues.filter((v) => blurbs.includes(v)).join(", "));
    // GW-13's disclosure is the other surface that paints raw host data. Open one and check it.
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await selectAgentByName("Atera Triage").catch(() => {});
    for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
    const chip = (await page.$$(".evidence-chip")).at(-1) ?? null;
    if (chip) {
      await chip.scrollIntoViewIfNeeded(); await chip.click(); await page.waitForTimeout(2500);
      const panel = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent ?? "");
      check(!secrets.some((s) => panel.includes(s)), "no adopted secret in the evidence disclosure");
      const heads = await page.$$eval("[data-head-slot]", (els) => els.map((e) => e.textContent.trim()));
      check(heads.length === 0 || heads.every((h) => /not on this page until you ask/i.test(h)), "attested tool output stays out of the DOM until asked for", `${heads.length} slot(s)`);
    } else {
      check(true, "no evidence chip on Atera to open in the leak pass");
    }
    // GW-09: attachment previews and avatar images are two more surfaces that paint host bytes.
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    const attachmentDom = await page.evaluate(() => Array.from(document.querySelectorAll("[data-attachment]")).map((e) => e.outerHTML).join(" ") + Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "").join(" "));
    check(!secrets.some((s) => attachmentDom.includes(s)), `no adopted secret in attachment previews or avatar sources (${(await page.$$("[data-attachment]")).length} attachment(s) on screen)`);
    const rest = await run(["scripts/verify-subscription-scan.mjs", "--leaks"]);
    check(rest.code === 0, "no adopted secret in endpoints.json, host log, transcripts, scan", rest.code === 0 ? "" : rest.out.split("\n").filter((l) => /FAIL/.test(l)).join("; "));
  } else if (TEACH) {
    // The operator's report was that Learn could not be stopped, so this gate is about the two
    // moments a click has to line up with the box: the modal opens only on a recording the host
    // confirmed, and every way out of it reaches stopTeachRecording. Discard is the exit that
    // costs no model turn, so the whole pass fits well inside the runner's ceiling.
    teachSettingBefore = await readSetting("SAND_TEACH");
    teachSettingTouched = true;
    check(await writeSetting("SAND_TEACH", "1"), "SAND_TEACH can be set to 1 in the box settings file", `was ${JSON.stringify(teachSettingBefore ?? null)}`);

    const probeName = `probe-teach-${Date.now()}`;
    const created = await gw("createAgent", { name: probeName, description: "verify-dashboard teach probe" }).catch(() => null);
    probeAgentId = created?.agent?.id ?? created?.id ?? null;
    if (!probeAgentId) check(false, "a fresh agent could be created for the teach probe");
    // The recorder refuses an agent without its own X display; fork windows start at 2
    // (SAND_BOX_FIRST_FORK_WINDOW_INDEX), and the websockify token in the vnc url IS that display.
    // Allocated under the page load, as the default pass does, because a cold box takes about 27s
    // over it.
    const screen = probeAgentId ? (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const status = await gw("ensureForeverBox", { id: probeAgentId }).catch(() => null);
        const url = String(status?.vncUrl ?? "");
        const display = Number(/token%3D(\d+)/i.exec(url)?.[1] ?? /token=(\d+)/i.exec(url)?.[1] ?? NaN);
        if (Number.isInteger(display) && display >= 2) return display;
        if (Date.now() > deadline) return null;
        await sleep(3000);
      }
    })() : Promise.resolve(null);

    await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(4000);
    check(await page.evaluate(() => window.__machineRoomLive === true), "the page is on the live gateway, not the demo adapter");
    const display = await screen;
    check(display != null, "the teach probe has its own desktop window", display == null ? "no fork display within 60s" : `display :${display}`);

    if (probeAgentId && display != null) {
      const before = new Set(await teachSessionDirs());
      await clickText(probeName);
      await page.click("#rail-screen .rail-screen-button"); await page.waitForTimeout(1500);
      await page.click("#teach-button");
      // The start is a 6s round trip on a warm screen and 23s on a cold one, and the only thing
      // that used to change on the page in that time was the button's disabled flag, which this
      // stylesheet did not draw at all. Read the button while the round trip is still in flight.
      const waiting = await page.evaluate(() => {
        const button = document.getElementById("teach-button");
        return {
          text: button?.textContent ?? "",
          busy: button?.getAttribute("aria-busy") ?? "",
          line: document.getElementById("teach-progress")?.textContent ?? "",
        };
      });
      check(/starting/i.test(waiting.text) && waiting.busy === "true" && /recording/i.test(waiting.line),
        "the page says the box is starting while the start is still in flight", JSON.stringify(waiting));
      // The modal is a claim that ffmpeg is rolling, so it must not appear before the host says so
      // and it must appear once the host has. Both directions are one wait.
      const opened = await until(() => page.evaluate(() => (document.getElementById("teach-dialog")?.open === true ? true : null)), 20_000, 500);
      check(opened === true, "clicking Learn opens the recording dialog once the host confirms the recording");
      const hostStatus = await gw("getTeachRecordingStatus").catch(() => null);
      check(hostStatus?.state === "recording" && hostStatus?.agentId === probeAgentId, "and the host reports that same agent recording", JSON.stringify(hostStatus));
      teachSessionDir = (await teachSessionDirs()).find((dir) => !before.has(dir)) ?? null;
      if (teachSessionDir) teachDirsMade.add(teachSessionDir);
      check(teachSessionDir != null, "a session directory appeared on the box for the recording", teachSessionDir ?? "");
      // The positive control for the check after the discard: an empty pgrep only means something
      // once it has been seen non-empty for this same recording.
      const rolling = (await box("pgrep -a ffmpeg || true")).out.split("\n").filter((line) => teachSessionDir && line.includes(teachSessionDir));
      check(rolling.length > 0, "and an ffmpeg on the box is writing it", rolling.join(" ").slice(0, 160));

      // The timer has to be the recording's, not a still frame: two samples across a second.
      const first = await page.evaluate(() => document.getElementById("teach-timer")?.textContent ?? "");
      await page.waitForTimeout(1500);
      const second = await page.evaluate(() => document.getElementById("teach-timer")?.textContent ?? "");
      check(first !== "" && first !== second, "the dialog's timer is running", `${first} then ${second}`);

      // A control whose textContent is right and whose pixels are off screen is the bug the
      // operator reported, and the old checks could not tell the two apart: the frame is a fixed
      // height that clips, Playwright clicks at viewport coordinates, so page.click succeeded on a
      // button no human could see. Ask the two questions a person asks -- is it inside the frame,
      // and does a click at its centre land on it.
      const painted = await page.evaluate(() => {
        const frame = document.querySelector(".teach-frame")?.getBoundingClientRect();
        if (!frame) return { error: "no teach frame" };
        const err = document.getElementById("teach-error");
        const wasHidden = err?.hidden ?? true;
        if (err) { err.hidden = false; err.textContent = "Clicking outside does not stop the recording."; }
        const look = (id) => {
          const el = document.getElementById(id);
          if (!el || el.hidden) return { id, missing: true };
          const box = el.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { id, inside: box.bottom <= frame.bottom + 1 && box.top >= frame.top - 1, hits: hit === el || el.contains(hit) };
        };
        const seen = ["discard-teach", "finish-teach", "teach-keyboard", "teach-error"].map(look);
        if (err) err.hidden = wasHidden;
        return { seen, clipped: document.querySelector(".teach-frame").scrollHeight > document.querySelector(".teach-frame").clientHeight + 1 };
      });
      const unpainted = (painted.seen ?? []).filter((el) => el.missing || !el.inside);
      check(unpainted.length === 0 && painted.clipped === false, "every control in the dialog's footer is painted inside the frame", JSON.stringify(painted).slice(0, 240));
      const unclickable = (painted.seen ?? []).filter((el) => (el.id === "discard-teach" || el.id === "finish-teach") && !el.hits);
      check(unclickable.length === 0, "and a click at each stop button's centre lands on that button", JSON.stringify(unclickable));

      // MR-14: a reload in the middle of a recording has to come back into that same recording,
      // on the host's clock rather than a fresh 00:00, and the way out of the resumed dialog has
      // to reach the box like any other.
      const clockSeconds = (text) => { const m = /(\d+):(\d+)/.exec(String(text ?? "")); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };
      await page.reload({ waitUntil: "load" }); await page.waitForTimeout(4500);
      const resumed = await until(() => page.evaluate(() => (document.getElementById("teach-dialog")?.open === true ? document.getElementById("teach-timer")?.textContent ?? "" : null)), 20_000, 500);
      check(resumed != null && clockSeconds(resumed) >= clockSeconds(second), "a reload during a recording reopens the dialog on the host's elapsed time", `${second} before the reload, ${resumed ?? "no dialog"} after`);

      // Escape is the operator's habitual dismiss and it did nothing at all: the live screen is a
      // VNC client served from another port, so its iframe is a separate process. It focuses
      // itself on connect and then keeps every key -- blurring it moves document.activeElement
      // back to this page and moves no keys, so activeElement is the one value a dead dialog also
      // reports correctly. Ask instead what the operator would notice: whether a typed note
      // arrives, and whether Escape reaches the box, with nothing in this dialog clicked.
      const focusTag = () => page.evaluate(() => document.activeElement?.tagName ?? "");
      const dialogFrames = () => page.evaluate(() => document.querySelectorAll("#teach-dialog iframe").length);
      await page.waitForTimeout(3000);
      const restingFocus = await focusTag();
      check(restingFocus !== "IFRAME", "the live screen does not hold the keyboard while nobody asked it to", `activeElement ${restingFocus}`);
      check(await page.evaluate(() => document.querySelector(".teach-shield")?.hidden === false), "and the screen is covered until the operator asks for it");
      const restingFrames = await dialogFrames();
      check(restingFrames === 0, "and no screen client is mounted behind the cover, which is what leaves the keys with the page", `${restingFrames} iframes in the dialog`);
      // The proof activeElement cannot give: characters that arrive, and keydowns this page saw.
      await page.evaluate(() => { window.__gateKeys = []; document.addEventListener("keydown", (event) => window.__gateKeys.push(event.key), true); });
      const typedNote = "gate typed this with nothing clicked";
      await page.keyboard.type(typedNote);
      const typedState = await page.evaluate(() => ({ value: document.getElementById("teach-note")?.value ?? "", keys: (window.__gateKeys ?? []).length }));
      check(typedState.value === typedNote, "a note typed on a dialog nobody has clicked reaches the dialog, not the recorded desktop", JSON.stringify(typedState).slice(0, 160));
      check(typedState.keys >= typedNote.length, "and this page sees those keys rather than only believing it has them", `${typedState.keys} keydowns for ${typedNote.length} characters`);

      // The fix itself: a way out that stops the box, pressed the way an operator presses it --
      // first thing, nothing clicked. Taken from the resumed dialog, which is the harder half:
      // nothing in this page started that recording.
      await page.keyboard.press("Escape");
      const escapeClosed = await until(() => page.evaluate(() => (document.getElementById("teach-dialog")?.open === false ? true : null)), 12_000, 500);
      check(escapeClosed === true, "Escape closes the recording dialog");
      const escapeIdle = await until(async () => ((await gw("getTeachRecordingStatus").catch(() => null))?.state === "idle" ? true : null), 15_000, 1000);
      check(escapeIdle === true, "and the host reports the recording idle, so Escape reached the box");
      // Asked without naming the path: the box's shell echoes the command it was given, so a
      // grep for the video would match its own command line and never fail.
      const afterEscape = (await box("pgrep -a ffmpeg || true")).out.split("\n").filter((line) => teachSessionDir && line.includes(teachSessionDir));
      check(afterEscape.length === 0, "and no ffmpeg is still writing that recording", afterEscape.join(" ").slice(0, 160));

      // Discard is the other way out, on a second recording this page did start. The reload above
      // put the page back on its default agent, so the probe has to be selected again first:
      // without that, this click starts a recording on a production agent's screen, and the host
      // measured it as one -- {"agentId":"4ef9b708-..."} for a dialog titled with the probe.
      await clickText(probeName); await page.waitForTimeout(1000);
      await page.click("#rail-screen .rail-screen-button"); await page.waitForTimeout(1200);
      const beforeSecond = new Set(await teachSessionDirs());
      await page.click("#teach-button");
      const reopened = await until(() => page.evaluate(() => (document.getElementById("teach-dialog")?.open === true ? true : null)), 30_000, 500);
      check(reopened === true, "a second Learn click opens the dialog on a second recording");
      teachSessionDir = (await teachSessionDirs()).find((dir) => !beforeSecond.has(dir)) ?? teachSessionDir;
      if (teachSessionDir) teachDirsMade.add(teachSessionDir);
      const secondRolling = (await box("pgrep -a ffmpeg || true")).out.split("\n").filter((line) => teachSessionDir && line.includes(teachSessionDir));
      check(secondRolling.length > 0, "and an ffmpeg on the box is writing it", secondRolling.join(" ").slice(0, 160));
      // The host's start() hands back whatever recording is already running, so a dialog can be
      // titled for one agent over another agent's screen. Nothing but the host's own attribution
      // says which agent this second recording belongs to.
      const secondStatus = await gw("getTeachRecordingStatus").catch(() => null);
      check(secondStatus?.state === "recording" && secondStatus?.agentId === probeAgentId, "and the host attributes it to the probe, not to another agent", JSON.stringify(secondStatus));

      // Taking control has to work, or this dialog cannot be used to demonstrate anything -- and
      // giving it back has to work, or the keyboard stays with the box for the rest of the
      // recording. Both are measured on the frame, not on activeElement.
      const coverReady = await until(() => page.evaluate(() => (/Click here to work on this screen/.test(document.querySelector(".teach-shield")?.textContent ?? "") ? true : null)), 40_000, 500);
      check(coverReady === true, "the cover offers the screen once the box has given the probe one");
      await page.click(".teach-shield"); await page.waitForTimeout(2500);
      const control = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? "", frames: document.querySelectorAll("#teach-dialog iframe").length }));
      check(control.frames === 1 && control.tag === "IFRAME", "clicking the cover mounts the screen and hands it the keyboard", JSON.stringify(control));
      await page.click("#teach-note"); await page.waitForTimeout(1500);
      const returned = await page.evaluate(() => {
        const note = document.getElementById("teach-note");
        if (note) note.value = "";
        return { tag: document.activeElement?.tagName ?? "", frames: document.querySelectorAll("#teach-dialog iframe").length };
      });
      check(returned.frames === 0 && returned.tag !== "IFRAME", "clicking back into the dialog unmounts the screen and takes the keyboard back", JSON.stringify(returned));
      await page.keyboard.type("back on the page");
      const backOnPage = await page.evaluate(() => document.getElementById("teach-note")?.value ?? "");
      check(backOnPage === "back on the page", "and typing lands in the dialog again, not on the recorded desktop", JSON.stringify(backOnPage));

      // A click outside the frame used to throw the recording away with no confirmation. The
      // dialog is modal, so every click on the page lands on it: measured, the frame is 1100x760
      // in a 1440x1000 viewport, which made about 42% of the screen a silent destroy button.
      await page.mouse.click(8, 8); await page.waitForTimeout(1500);
      const afterStray = await gw("getTeachRecordingStatus").catch(() => null);
      check(await page.evaluate(() => document.getElementById("teach-dialog")?.open === true), "a stray click outside the dialog does not close it");
      check(afterStray?.state === "recording" && afterStray?.agentId === probeAgentId, "and the box is still recording", JSON.stringify(afterStray));
      check(await page.evaluate(() => /does not stop the recording/i.test(document.getElementById("teach-error")?.textContent ?? "")), "and the dialog says so where it can be read, not in a toast behind the modal");

      await page.click("#discard-teach");
      const closed = await until(() => page.evaluate(() => (document.getElementById("teach-dialog")?.open === false ? true : null)), 20_000, 500);
      check(closed === true, "Discard closes the dialog");
      const idle = await until(async () => ((await gw("getTeachRecordingStatus").catch(() => null))?.state === "idle" ? true : null), 15_000, 1000);
      check(idle === true, "and the host reports the recording idle, so the stop reached the box");
      const ffmpeg = (await box("pgrep -a ffmpeg || true")).out.split("\n").filter((line) => teachSessionDir && line.includes(teachSessionDir));
      check(ffmpeg.length === 0, "and no ffmpeg is still writing that agent's recording", ffmpeg.join(" ").slice(0, 160));
      const toast = await page.evaluate(() => document.getElementById("toast")?.textContent ?? "");
      check(/discard/i.test(toast), "and the page says the recording was discarded, not saved", toast.slice(0, 120));

      // A saved recording ends in a learning turn that writes a skill, and an open Skills panel has
      // to show it with no reload. Nothing polls for that: loadContext re-reads getAgentWorkflows
      // on every refresh already. So put a workflow on the host the way the learning turn does and
      // wait for the open panel to pick it up on its own. No model turn is spent to prove it.
      libraryBefore = await libraryIds(probeAgentId).catch(() => null);
      await page.click('[data-capability="skills"]'); await page.waitForTimeout(2500);
      check(await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent === "Agent skills"), "the Skills panel opens for the probe");
      const learnedName = `Gate learned skill ${Date.now()}`;
      await gw("createAgentWorkflow", { id: probeAgentId, spec: { name: learnedName, description: "written the way a learning turn writes one", body: "Do the demonstrated task.", trigger: null } }).catch((e) => check(false, "a workflow could be written to the host", e.message));
      const listed = await until(() => page.evaluate((name) => (document.getElementById("panel-content")?.innerText.includes(name) ? true : null), learnedName), 22_000, 1000);
      check(listed === true, "a skill that lands on the host during a turn shows up in the open Skills panel with no reload");
      await page.keyboard.press("Escape"); await page.waitForTimeout(600);

      // With the switch off there is nothing to stop, so there must be no dialog -- and the page
      // has to name the switch, because the operator is the only one who can flip it.
      check(await writeSetting("SAND_TEACH", "0"), "SAND_TEACH can be set back to 0 for the refusal pass");
      await page.click("#rail-screen .rail-screen-button"); await page.waitForTimeout(1200);
      await page.click("#teach-button"); await page.waitForTimeout(3000);
      check(await page.evaluate(() => document.getElementById("teach-dialog")?.open === false), "a refused start opens no dialog");
      const refusal = await page.evaluate(() => ({
        inline: document.getElementById("teach-refusal")?.textContent ?? "",
        body: document.body.innerText,
      }));
      check(/SAND_TEACH/.test(refusal.inline), "the reason is on screen beside the button that was clicked", refusal.inline.slice(0, 140));
      // "Beside" is a geometric claim, and it was 719px below the button and at the other end of
      // the dialog, next to Pause. Measure it instead of asserting the text and calling it beside.
      const beside = await page.evaluate(() => {
        const line = document.getElementById("teach-refusal"), button = document.getElementById("teach-button");
        if (!line || line.hidden || !button) return { missing: true };
        const a = line.getBoundingClientRect(), b = button.getBoundingClientRect();
        return { gap: Math.round(Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right))), rows: Math.round(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2)) };
      });
      check(beside.missing !== true && beside.gap <= 48 && beside.rows <= 40, "and it is drawn beside that button rather than at the far edge of the dialog", JSON.stringify(beside));
      check(/Teach mode is off on this host/.test(refusal.body), "and the page text says teach mode is off on this host");
      check((await gw("getTeachRecordingStatus").catch(() => null))?.state === "idle", "and nothing started on the box");
    }
  } else {
    // -- MR-06 and GW-03(a): one probe turn serves both. The prompt goes through the composer, so
    // the acceptance state the composer shows is asserted against the host's own ledger for the
    // same nonce; the reply then raises a real unread on an agent that is not on screen.
    const probeName = `Unread probe ${Date.now()}`;
    const created = await gw("createAgent", { name: probeName, description: "verify-dashboard unread probe" }).catch(() => null);
    probeAgentId = created?.agent?.id ?? created?.id ?? null;
    let raisedUnread = null;
    if (!probeAgentId) check(false, "a fresh agent could be created for the unread probe");
    // A fresh agent has no screen; ensureForeverBox allocates one, measured at 27s cold on this
    // box (2026-09-03, direct curl), over the 25s the Agent details row used to wait. Start the
    // allocation now so it runs under the page load and the probe turn, and await it before the
    // panel opens so the row's own ensureForeverBox finds the screen already assigned.
    const screenWarm = probeAgentId ? gw("ensureForeverBox", { id: probeAgentId }).catch((e) => ({ warmError: e.message })) : Promise.resolve(null);
    if (probeAgentId) libraryBefore = await libraryIds(probeAgentId).catch(() => null);

    await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(4000);
    check(await page.evaluate(() => window.__machineRoomLive === true), "the page is on the live gateway, not the demo adapter", await page.evaluate(() => window.__machineRoomError ?? ""));

    // -- MR-31: the roster scrolls above the control shelf instead of running under it, so the Hidden
    // group at its bottom stays clickable however many agents the box holds.
    {
      const geometry = await page.evaluate(() => {
        const stack = document.getElementById("worker-stack"), shelf = document.querySelector("footer.control-shelf, .control-shelf");
        if (!stack || !shelf) return null;
        const cs = getComputedStyle(stack), s = stack.getBoundingClientRect(), f = shelf.getBoundingClientRect();
        return { overflowY: cs.overflowY, maxHeight: cs.maxHeight, stackBottom: Math.round(s.bottom), shelfTop: Math.round(f.top), scrolls: stack.scrollHeight > stack.clientHeight };
      });
      check(geometry != null && geometry.overflowY === "auto" && geometry.maxHeight !== "none", "the roster stack is bounded and scrolls on its own", JSON.stringify(geometry));
      check(geometry != null && geometry.stackBottom <= geometry.shelfTop, "and its bottom stays above the control shelf", JSON.stringify(geometry));
    }

    // -- MR-28/29/30 and the real-time roster. An agent minted on any surface after the page loaded
    // (Titan minted "Scribe" from a turn) has to reach the sidebar from the host's own event stream,
    // not from a browser reload; its long description stays out of the status line, the header and
    // the pill; and nothing in the sidebar runs past its card.
    {
      const LONG = "Online course note-taker and study-material builder. Captures and organizes notes from the user's online courses while access is still active, preserving structure: modules, lessons, key concepts, definitions, formulas, and examples. Then turns the material into study aids.";
      const liveName = `Roster probe ${Date.now()}`;
      const made = await gw("createAgent", { name: liveName, description: LONG }).catch(() => null);
      const liveId = made?.agent?.id ?? made?.id ?? null;
      check(liveId != null, "an agent can be minted after the page loaded (the Scribe case)");
      if (liveId != null) {
        try {
          const card = await until(() => page.evaluate((id) => {
            const el = document.querySelector(`.worker-card[data-context-id="${id}"]`);
            if (!el) return null;
            const status = el.querySelector(".worker-status");
            return { status: status?.textContent?.trim() ?? "", overflow: status ? status.scrollWidth > status.clientWidth + 1 : null, cardOverflow: el.scrollWidth > el.clientWidth + 1 };
          }, liveId), 20_000, 500);
          check(card != null, "the minted agent reaches the sidebar with no reload (stream, then heartbeat)", card == null ? "no card within 20s" : "card drawn");
          if (card != null) {
            check(card.status === "Ready for the next task", "its status line says its state, not its description", JSON.stringify(card.status.slice(0, 60)));
            check(card.overflow === false && card.cardOverflow === false, "and nothing on the card runs past its edge", JSON.stringify(card));
          }
          const header = await page.evaluate(() => { const el = document.getElementById("room-subtitle"); return el ? { text: el.textContent.trim(), overflow: el.scrollWidth > el.clientWidth + 1 } : null; });
          check(header != null && header.overflow === false, "the conversation header's second line fits its box", JSON.stringify(header));
          // styles.css:495 -- an agent that wants a human deliberately STOPS breathing and turns
          // amber (`.worker-card[data-status="attention"] .worker-avatar { animation: none;
          // border-color: var(--warning) }`). The old assertion was "every avatar breathes", which
          // reads that intended state as a defect: it passed only while no agent on this box was in
          // attention, and failed the moment one was, reporting the warning colour as a wrong accent.
          // Assert the contract the stylesheet actually states, per card, off its own data-status.
          const rings = await page.evaluate(() => Array.from(document.querySelectorAll(".worker-card")).map((el) => ({
            status: el.getAttribute("data-status") ?? "",
            accent: getComputedStyle(el).getPropertyValue("--accent").trim(),
            border: getComputedStyle(el.querySelector(".worker-avatar")).borderTopColor,
            animation: getComputedStyle(el.querySelector(".worker-avatar")).animationName,
          })));
          const ringOk = (r) => Boolean(r.accent) && (r.status === "attention" ? r.animation === "none" : r.animation !== "none" && Boolean(r.animation));
          check(rings.length > 0 && rings.every(ringOk), "every avatar carries its agent's accent, and breathes unless the agent wants a human", JSON.stringify(rings.filter((r) => !ringOk(r)).slice(0, 3)) + ` of ${rings.length}, ${rings.filter((r) => r.status === "attention").length} in attention`);

          // -- AVATAR-1: the faces are the Titan crew, on live canvases, and they move.
          const crewCards = await page.evaluate(() => Array.from(document.querySelectorAll(".worker-card:not(.room-card)")).map((el) => ({
            name: el.querySelector(".worker-name")?.textContent?.trim() ?? "",
            character: el.querySelector("[data-titan-character]")?.dataset.titanCharacter ?? null,
            canvas: Boolean(el.querySelector("titan-mascot")),
            mood: el.querySelector("[data-titan-mood]")?.dataset.titanMood ?? "",
            status: el.getAttribute("data-status") ?? "",
          })));
          const facesOk = crewCards.length > 0 && crewCards.every((c) => c.character && c.canvas);
          check(facesOk, "every roster card draws its agent as a Titan crew member on a live canvas", crewCards.map((c) => `${c.name}:${c.character ?? "none"}`).join(", "));
          // Titan is the first agent of an instance, and no companion is handed out twice while
          // there are companions left. Both are mascot-crew.js's contract, read off the page.
          check(crewCards.some((c) => c.character === "Titan"), "and one of them is Titan, who is always the first agent on an instance");
          const companions = crewCards.map((c) => c.character).filter((c) => c && c !== "Titan");
          check(companions.length > 12 || new Set(companions).size === companions.length, "no companion is drawn twice while there are unused ones", companions.join(", "));
          // The mood is the status the roster already paints, not a second opinion about it.
          const moodOk = crewCards.every((c) => (c.status === "working" ? c.mood === "curious" : ["calm", "excited", "curious"].includes(c.mood)));
          check(moodOk, "a card that says Working now carries the curious mood", crewCards.map((c) => `${c.name}:${c.status}/${c.mood}`).join(", "));
          // Actually moving: the same canvases, 500ms apart, must not be the same picture. The
          // element's own IntersectionObserver stops the ones the collapsed Hidden group holds, so
          // only the cards on screen are compared.
          const frameOf = () => page.evaluate(() => Array.from(document.querySelectorAll(".worker-card:not([data-roster-hidden] *) titan-mascot")).map((m) => m.snapshot().slice(-160)));
          const frameA = await frameOf();
          await page.waitForTimeout(500);
          const frameB = await frameOf();
          const moved = frameA.filter((x, i) => x !== frameB[i]).length;
          check(frameA.length > 0 && moved === frameA.length, "and each one is a different picture 500ms later", `${moved} of ${frameA.length} canvases moved`);
          // A canvas nobody can see must not cost anything. The Hidden group is collapsed here.
          const parkedFrames = async () => page.evaluate(() => Array.from(document.querySelectorAll("[data-roster-hidden] titan-mascot")).map((m) => m.snapshot().slice(-160)));
          const parkedA = await parkedFrames();
          if (parkedA.length === 0) notReached("this box has no agent hidden from the sidebar", "a canvas inside the collapsed Hidden group is paused");
          else {
            await page.waitForTimeout(500);
            const parkedB = await parkedFrames();
            const stillParked = parkedA.filter((x, i) => x === parkedB[i]).length;
            check(stillParked === parkedA.length, "a canvas inside the collapsed Hidden group is paused", `${stillParked} of ${parkedA.length} paused`);
          }
          // The budget: main-thread work over ten seconds with every canvas on this roster running.
          // Chrome's own TaskDuration against wall clock, plus any long task the page produced.
          const perf = await page.context().newCDPSession(page);
          await perf.send("Performance.enable");
          const metricsOf = async () => Object.fromEntries((await perf.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
          const longTasks = await page.evaluate(() => { window.__gateLongTasks = []; try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__gateLongTasks.push(Math.round(e.duration)); }); o.observe({ entryTypes: ["longtask"] }); window.__gateLongTaskObserver = o; return true; } catch { return false; } });
          const perfBefore = await metricsOf();
          await page.waitForTimeout(10_000);
          const perfAfter = await metricsOf();
          const tasks = longTasks ? await page.evaluate(() => { window.__gateLongTaskObserver?.disconnect(); return window.__gateLongTasks; }) : [];
          const wallSeconds = perfAfter.Timestamp - perfBefore.Timestamp;
          const busySeconds = perfAfter.TaskDuration - perfBefore.TaskDuration;
          const share = wallSeconds > 0 ? busySeconds / wallSeconds : 1;
          check(share < 0.3, "with every canvas running, the main thread stays under 30% of a second per second", `${(share * 100).toFixed(1)}% over ${wallSeconds.toFixed(1)}s (${frameA.length} canvas(es) on screen), ${tasks.length} long task(s)${tasks.length ? ` of ${Math.max(...tasks)}ms` : ""}`);
        } finally {
          await gw("deleteAgents", { ids: [liveId] }).catch((e) => console.log(`  INFO  roster probe NOT deleted: ${e.message}`));
        }
        const gone = await until(() => page.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"]`) == null ? true : null, liveId), 20_000, 500);
        check(gone === true, "and a deleted agent leaves the sidebar with no reload", gone === true ? "card gone" : "card still drawn after 20s");
      }
    }
    // GW-14: the gate is consulted once, at boot, before anything below clears the call log.
    const consultedSearch = callsTo("isGlobalSearchEnabled") >= 1;
    const searchEnabled = await gw("isGlobalSearchEnabled").catch(() => null);

    if (probeAgentId) {
      await clickText(probeName);
      // GW-09: the two attachments ride the probe turn, so one model turn serves the acceptance,
      // the unread and the inline rendering. Uploaded on pick through uploadAttachment; the tray
      // says "uploading…" until the host has answered with a path.
      await page.setInputFiles("#composer-file", [
        { name: "gate-shot.png", mimeType: "image/png", buffer: pngOf(8) },
        { name: "gate-notes.txt", mimeType: "text/plain", buffer: Buffer.from(NOTES_TEXT) },
      ]);
      const staged = await until(() => page.evaluate(() => { const t = document.getElementById("attachment-tray"); return t && !t.hidden && t.querySelectorAll(".tag").length === 2 && !/uploading/.test(t.textContent) ? true : null; }), 15_000, 500);
      check(staged === true, "two files staged through uploadAttachment before the send", staged ? "" : await page.evaluate(() => document.getElementById("attachment-tray")?.textContent ?? ""));
      await page.fill("#message-input", "Reply with the single word: ready.");
      await page.click("#composer button[type=submit]");
      // sendPrompt answers { accepted: true } no matter what; the composer's word has to be the
      // ledger's. Wait for a state other than "sending", then ask the host for the same nonce.
      const acceptance = await until(() => page.evaluate(() => {
        const el = document.getElementById("composer-status");
        return el && !el.hidden && el.dataset.composerState !== "sending" ? { state: el.dataset.composerState, text: el.textContent, nonce: el.dataset.clientNonce ?? null } : null;
      }), 20_000, 500);
      check(acceptance?.state === "accepted" && /Accepted by the host/.test(acceptance.text), "after a send the composer shows the host's acceptance, not the click", acceptance ? `${acceptance.state}: ${acceptance.text}` : "no acceptance state inside 20s");
      const ledger = acceptance?.nonce ? await gw("promptAcceptanceStatus", { accountSlot: "host", clientNonce: acceptance.nonce }).catch(() => null) : null;
      check(ledger?.outcome === "found" && ledger.record?.status === "accepted", "and promptAcceptanceStatus holds that nonce as accepted", JSON.stringify(ledger ?? null).slice(0, 120));
      // MR-26. With that status on screen the shelf must still be one row: the status used to be
      // a fourth item in a three-column grid, which wrapped the three utilities and the routine
      // ring onto a row nobody can see and slid the composer into their column (seen on the R750).
      const shelf = await page.evaluate(() => {
        const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
        const bar = r(".control-shelf"), util = r(".shelf-utilities"), status = r("#composer-status"), composer = r(".composer");
        const inside = !!(bar && util && util.w > 0 && util.y >= bar.y && util.y + util.h <= bar.y + bar.h + 1 && util.x + util.w <= bar.x + bar.w + 1);
        const above = !!(status && bar && status.h > 0 && status.y + status.h <= bar.y + 2);
        const composerLeftOfUtilities = !!(composer && util && composer.x + composer.w <= util.x + 1);
        return { inside, above, composerLeftOfUtilities, buttons: document.querySelectorAll(".shelf-utilities .icon-button").length };
      });
      check(shelf.inside && shelf.composerLeftOfUtilities && shelf.buttons === 3, "the shelf keeps its three utilities beside the composer while the status shows", JSON.stringify(shelf));
      check(shelf.above, "and the status floats above the shelf instead of taking a column", JSON.stringify(shelf));
      // MR-27. A long box-wide endpoint name widened the Agent panel past the window edge on the
      // R750. Put the long value in and measure the panel, not the column.
      const panel = await page.evaluate(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { right: Math.round(b.right), w: Math.round(b.width) }; };
        const aside = document.querySelector("aside.context-space"); const island = aside?.querySelector(".context-island"); const capsule = null; // the desktop capsule is gone: the screen tile at the top of the rail opens the desktop (Jason, 2026-09-08 22:42)
        const strong = [...(aside?.querySelectorAll(".context-detail-row") ?? [])].find((row) => /Endpoint/.test(row.textContent))?.querySelector("strong");
        const kept = strong?.textContent ?? null; if (strong) strong.textContent = "Alibaba Model Studio (token plan) · qwen3.8-max";
        const out = { column: r(aside), island: r(island), capsule: r(capsule), viewport: document.documentElement.clientWidth };
        if (strong && kept != null) strong.textContent = kept;
        return out;
      });
      check(!!panel.island && panel.island.w <= panel.column.w + 1 && panel.island.right <= panel.viewport && (!panel.capsule || panel.capsule.w <= panel.column.w + 1), "a long endpoint name cannot widen the Agent panel past its column", JSON.stringify(panel));
      // Read somewhere else while the reply lands, so the unread is raised off screen.
      await selectAgentByName("Atera Triage").catch(() => {});
      const spoke = await until(async () => {
        const t = await gw("getAgentTranscriptTail", { id: probeAgentId, limit: 10 });
        return (t?.entries ?? []).some((e) => e.kind === "send-message") ? true : null;
      }, TURN_TIMEOUT_MS, 3000);
      raisedUnread = spoke ? await until(async () => {
        const agents = await gw("listAgents");
        const row = (agents ?? []).find((a) => a.id === probeAgentId);
        return (row?.unreadCount ?? 0) > 0 ? row.unreadCount : null;
      }, 20_000) : null;
      // A cold or unreachable provider is not a dashboard defect. If nothing came back, say the
      // probe was skipped and move on; if it did come back, the badge is a real assertion.
      if (!spoke) check(true, `unread probe skipped — no reply inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s turn budget (the box's endpoint, not the dashboard)`);
      else check(raisedUnread != null, "a fresh agent's reply raises an unread count on the host", raisedUnread ? `${raisedUnread} unread` : "the agent replied but the host reported no unread");
    }

    // Only meaningful if an unread was actually raised: with none, unreadCount is already 0 and
    // the clear would pass for the wrong reason. The page is on Atera, so this is a real change.
    if (probeAgentId && raisedUnread != null) {
      await clickText(probeName);
      const cleared = await until(async () => {
        const agents = await gw("listAgents");
        const row = (agents ?? []).find((a) => a.id === probeAgentId);
        return row && (row.unreadCount ?? 0) === 0 ? true : null;
      }, 15_000, 1500);
      check(cleared === true, "reading that conversation clears its unread on the host");
    }

    // -- GW-09: the two uploaded files render inline on the probe's conversation. The image
    // through readAttachmentImage, the text file as a bounded preview through readAttachmentText
    // whose "Show more" pages the rest in.
    if (probeAgentId) {
      if (!(await page.evaluate(() => document.getElementById("room-title")?.textContent)).startsWith("Unread probe")) await clickText(probeName);
      const image = await until(() => page.evaluate(() => { const img = document.querySelector("#transcript img.attachment-image"); return img && /^data:image\/png;base64,/.test(img.getAttribute("src") ?? "") ? img.getAttribute("src").length : null; }), 15_000, 800);
      check(image != null && callsTo("readAttachmentImage") >= 1, "the uploaded PNG renders as an <img> in the transcript through readAttachmentImage", image ? `${image} chars of data URL, ${callsTo("readAttachmentImage")} read(s)` : `no image; ${callsTo("readAttachmentImage")} read(s)`);
      const preview = await until(() => page.evaluate(() => { const pre = document.querySelector("#transcript [data-attachment-kind='file'] .attachment-preview"); return pre && /gate attachment probe/.test(pre.textContent) ? pre.textContent : null; }), 15_000, 800);
      check(preview != null && callsTo("readAttachmentText") >= 1 && preview.length <= 1500 && preview.length < NOTES_TEXT.length, "the uploaded text file renders a bounded preview through readAttachmentText", preview ? `${preview.length} of ${NOTES_TEXT.length} chars shown, ${callsTo("readAttachmentText")} read(s)` : `no preview; ${callsTo("readAttachmentText")} read(s)`);
      const more = await page.$("#transcript [data-attachment-kind='file'] [data-attachment-more]");
      check(more != null, "and offers to show more of it");
      if (more && preview) {
        await more.click(); await page.waitForTimeout(600);
        const grown = await page.evaluate(() => document.querySelector("#transcript [data-attachment-kind='file'] .attachment-preview")?.textContent.length ?? 0);
        check(grown > preview.length, "Show more reveals the next slice", `${preview.length} → ${grown} chars`);
      }
    }

    // -- QOL-COMPOSER: the composer grew up. It is a textarea that follows its content, Enter
    // sends and Shift+Enter opens a line, a file dropped on the conversation attaches the way the
    // "+" does, and a paste too big for the box becomes a file rather than a wall of text. All of
    // it on the probe agent, which is still the open conversation.
    if (probeAgentId) {
      if (!(await page.evaluate(() => document.getElementById("room-title")?.textContent)).startsWith("Unread probe")) await clickText(probeName);
      // The box itself: one line at rest, taller with content, and stopping around eight lines.
      const grows = await page.evaluate(() => {
        const el = document.getElementById("message-input");
        if (!el || el.tagName !== "TEXTAREA") return { tag: el ? el.tagName : "missing" };
        const set = (value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); return Math.round(el.getBoundingClientRect().height); };
        const box = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { y: Math.round(b.y), h: Math.round(b.height) } : null; };
        const one = set("one line");
        const three = set("one\ntwo\nthree");
        const twenty = set(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
        // Read the geometry while the box is still at its eight-line cap: a grown composer that
        // leaves its shelf is the failure the height numbers alone cannot see.
        const grown = { composer: box(".composer"), bar: box(".control-shelf") };
        set("");
        return { tag: el.tagName, one, three, twenty, grown };
      });
      check(grows.tag === "TEXTAREA", "the composer is a textarea, not a one-line input", JSON.stringify(grows));
      check(grows.three > grows.one && grows.twenty > grows.three && grows.twenty <= grows.one * 9, "and it follows its content, stopping around eight lines", JSON.stringify(grows));
      check(
        !!grows.grown?.composer && !!grows.grown?.bar
          && grows.grown.composer.y >= grows.grown.bar.y - 1
          && grows.grown.composer.y + grows.grown.composer.h <= grows.grown.bar.y + grows.grown.bar.h + 1,
        "and the shelf grows with it, so an eight-line composer stays inside the bar",
        JSON.stringify(grows.grown),
      );

      // Shift+Enter opens a line and sends nothing; Enter sends, and the transcript keeps both.
      const userRows = () => page.evaluate(() => document.querySelectorAll("#transcript .message-row.is-user").length);
      const rowsBefore = await userRows();
      await page.click("#message-input");
      await page.keyboard.type("composer line one");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("composer line two");
      const held = await page.evaluate(() => document.getElementById("message-input").value);
      check(held.split("\n").length === 2 && /composer line one/.test(held) && /composer line two/.test(held), "Shift+Enter opens a second line in the composer", JSON.stringify(held));
      check((await userRows()) === rowsBefore, "and sends nothing", `${rowsBefore} user rows before and after`);
      await page.keyboard.press("Enter");
      const sent = await until(() => page.evaluate(() => {
        const rows = document.querySelectorAll("#transcript .message-row.is-user");
        const last = rows[rows.length - 1];
        if (!last) return null;
        const paras = [...last.querySelectorAll(".message-bubble p")].map((p) => p.textContent.trim());
        return paras.includes("composer line one") && paras.includes("composer line two") ? { paras, left: document.getElementById("message-input").value } : null;
      }), 15_000, 500);
      check(sent != null, "Enter sends it and the transcript keeps both lines", sent ? JSON.stringify(sent.paras) : "no two-line user row inside 15s");
      check(sent != null && sent.left === "", "and the composer is empty afterwards", sent ? JSON.stringify(sent.left) : "");

      // A synthetic drop over the conversation, carrying the same DataTransfer a real drag does.
      const dropNames = ["gate-drop-a.txt", "gate-drop-b.txt"];
      const dropped = await page.evaluate((names) => {
        const transfer = new DataTransfer();
        for (const name of names) transfer.items.add(new File([`${name} from the gate\n`], name, { type: "text/plain" }));
        const target = document.getElementById("transcript");
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        const glowing = document.body.dataset.composerDrop === "1";
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        return { glowing, cleared: document.body.dataset.composerDrop !== "1" };
      }, dropNames);
      check(dropped.glowing === true, "dragging files over the conversation lights the drop target", JSON.stringify(dropped));
      check(dropped.cleared === true, "and the highlight goes out on the drop", JSON.stringify(dropped));
      const chips = await until(() => page.evaluate(() => {
        const tray = document.getElementById("attachment-tray");
        if (!tray || tray.hidden) return null;
        const tags = [...tray.querySelectorAll(".tag")].map((t) => t.textContent);
        return tags.length === 2 && !tags.some((t) => /uploading/.test(t)) ? tags : null;
      }), 20_000, 500);
      check(chips != null, "and both dropped files stage as chips through uploadAttachment", chips ? JSON.stringify(chips) : await page.evaluate(() => document.getElementById("attachment-tray")?.textContent ?? "the tray is empty"));
      // The MR-26 geometry with files staged. The tray was an unstyled fourth item in a
      // three-column shelf, so the first chip pushed the composer into the utilities' column and
      // clipped its text under the shelf's edge; it floats above the composer now.
      const trayShelf = await page.evaluate(() => {
        const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
        return { bar: r(".control-shelf"), util: r(".shelf-utilities"), composer: r(".composer"), tray: r("#attachment-tray") };
      });
      check(!!trayShelf.composer && !!trayShelf.util && trayShelf.composer.x + trayShelf.composer.w <= trayShelf.util.x + 1 && trayShelf.util.y + trayShelf.util.h <= trayShelf.bar.y + trayShelf.bar.h + 1, "a staged tray does not take the composer's column", JSON.stringify(trayShelf));
      check(!!trayShelf.tray && !!trayShelf.bar && trayShelf.tray.y + trayShelf.tray.h <= trayShelf.bar.y + 2, "it floats above the shelf instead", JSON.stringify(trayShelf.tray));
      const attachmentNames = async () => ((await gw("getAgentTranscriptTail", { id: probeAgentId, limit: 40 }))?.entries ?? [])
        .filter((e) => e.kind === "user-attachment")
        .map((e) => e.file_name || String(e.file_path ?? "").split("/").pop());
      await page.fill("#message-input", "Two dropped files. No reply needed.");
      await page.keyboard.press("Enter");
      const delivered = await until(async () => {
        const names = await attachmentNames();
        return dropNames.every((n) => names.includes(n)) ? names.slice(-4) : null;
      }, 20_000, 1000);
      check(delivered != null, "and the send delivers both of them to the host", delivered ? JSON.stringify(delivered) : "neither dropped file reached the transcript inside 20s");
      check((await page.evaluate(() => document.getElementById("attachment-tray")?.hidden)) === true, "the tray empties on the send");

      // A paste no one-line box could hold. It becomes a file, and the chip says so.
      const pastedInto = await page.evaluate(() => {
        const el = document.getElementById("message-input");
        el.focus();
        const transfer = new DataTransfer();
        transfer.setData("text/plain", "p".repeat(5000));
        el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        return el.value;
      });
      check(pastedInto === "", "a 5,000-character paste never lands in the composer", JSON.stringify(pastedInto.slice(0, 40)));
      const pasteChip = await until(() => page.evaluate(() => {
        const tray = document.getElementById("attachment-tray");
        if (!tray || tray.hidden) return null;
        const tags = [...tray.querySelectorAll(".tag")].map((t) => t.textContent);
        return tags.length === 1 && !/uploading/.test(tags[0]) ? tags[0] : null;
      }), 20_000, 500);
      check(pasteChip != null && /pasted-\d{8}-\d{6}\.txt/.test(pasteChip), "it stages as one pasted-<stamp>.txt file instead", pasteChip ?? "no chip inside 20s");
      check(pasteChip != null && /pasted 5,000 characters/.test(pasteChip), "and the chip says what happened", pasteChip ?? "");
      await page.click("#attachment-tray [data-drop-attachment]");
      check((await page.evaluate(() => document.getElementById("attachment-tray")?.hidden)) === true, "and a staged chip can be taken back off before the send");
    }

    // -- GW-05: the Skills panel, on the probe agent, every step read back through getAgentWorkflows.
    if (probeAgentId) {
      if (!(await page.evaluate(() => document.getElementById("room-title")?.textContent)).startsWith("Unread probe")) await clickText(probeName);
      await page.click("[data-capability='skills']"); await page.waitForTimeout(1500);
      check((await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent)) === "Agent skills", "the Skills capability opens the agent's Skills panel");
      // A skill is either this agent's own or the box's, and the panel has to say which is which:
      // Delete and Make global on a global one reach every agent, on an owned one only its owner.
      const intro = await page.evaluate(() => document.querySelector("#panel-content .panel-intro p")?.textContent ?? "");
      check(/its own/.test(intro) && /global/i.test(intro) && /every agent/.test(intro), "the Skills panel says which skills are this agent's own and which are the box's", intro.slice(0, 120));
      await page.evaluate(() => document.querySelectorAll("#panel-content details").forEach((d) => { d.open = true; }));
      await page.fill("#skill-markdown", "---\nname: Gate probe skill\ndescription: verify-dashboard probe\n---\nReply with the single word: done.");
      await page.click("[data-import-skill-text] button[type=submit]");
      const listed = await until(() => page.$("[data-skill-name='Gate probe skill']"), 15_000, 800);
      check(listed != null, "importing pasted markdown lists the skill on the panel");
      const hostRow = (await gw("getAgentWorkflows", { id: probeAgentId }).catch(() => [])).find((w) => w.name === "Gate probe skill") ?? null;
      check(hostRow != null && hostRow.isEnabledForAgent !== false, "and the host lists it through getAgentWorkflows, enabled", hostRow ? hostRow.id : "not on the host");
      if (hostRow) {
        const toggle = `[data-skill-id="${hostRow.id}"] [data-toggle-skill]`;
        const enabledOnHost = async () => (await gw("getAgentWorkflows", { id: probeAgentId })).find((w) => w.id === hostRow.id)?.isEnabledForAgent;
        const switchReads = (want) => until(() => page.evaluate(([s, w]) => (document.querySelector(s)?.getAttribute("aria-pressed") === w ? true : null), [toggle, want]), 10_000, 500);
        await page.click(toggle);
        const off = await until(async () => ((await enabledOnHost()) === false ? true : null), 10_000, 800);
        check(off === true, "the panel's switch disables the skill on the host");
        await switchReads("false");
        await page.click(toggle);
        const on = await until(async () => ((await enabledOnHost()) === true ? true : null), 10_000, 800);
        check(on === true, "and enables it again");
        await switchReads("true"); await page.waitForTimeout(800);
        // Run once. The host's runAgentWorkflowNow drops the agent id for an unscheduled skill, so
        // the adapter sends the same @-reference prompt addressed to this agent; the proof is the
        // prompt landing in THIS agent's transcript, and its reply if one comes inside budget.
        const lastBefore = (await gw("getAgentTranscriptTail", { id: probeAgentId, limit: 1 }))?.entries?.at(-1)?.id ?? null;
        await page.click(`[data-skill-id="${hostRow.id}"] [data-run-skill]`);
        const dispatched = await until(async () => {
          const t = await gw("getAgentTranscriptTail", { id: probeAgentId, limit: 6 });
          return (t?.entries ?? []).some((e) => e.kind === "message" && e.role === "user" && /Gate probe skill/.test(userTextOf(e))) ? true : null;
        }, 15_000, 1500);
        check(dispatched === true, "Run now sends the skill to the probe agent (the @-reference prompt is in its transcript)");
        const replied = await until(async () => {
          const t = await gw("getAgentTranscriptTail", { id: probeAgentId, limit: 6 });
          const entries = t?.entries ?? [];
          const from = entries.findIndex((e) => e.id === lastBefore);
          return entries.slice(from + 1).some((e) => e.kind === "send-message") ? true : null;
        }, TURN_TIMEOUT_MS, 3000);
        check(true, replied ? "and the agent answered the skill run" : `skill run reply skipped — none inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s turn budget (the box's endpoint, not the dashboard)`);
        // Delete through the UI: two clicks, and the first one deletes nothing.
        const del = `[data-skill-id="${hostRow.id}"] [data-delete-skill]`;
        await page.click(del); await page.waitForTimeout(400);
        check((await page.evaluate((s) => document.querySelector(s)?.textContent, del)) === "Confirm", "deleting a skill arms on the first click");
        const armToast = await page.evaluate(() => document.getElementById("toast")?.textContent ?? "");
        check(/every agent on the box/.test(armToast), "and the arming toast says the delete reaches every agent", armToast.slice(0, 90));
        check((await enabledOnHost()) != null, "and the first click deletes nothing on the host");
        await page.click(del);
        const gone = await until(async () => ((await enabledOnHost()) == null ? true : null), 10_000, 800);
        check(gone === true, "the second click deletes it on the host");
        const unlisted = await until(async () => ((await page.$(`[data-skill-id="${hostRow.id}"]`)) ? null : true), 8_000, 500);
        check(unlisted === true, "and the panel no longer lists it");
      }
      // portAgentLocalSkills: the host scans its own cwd and home; whatever it links is read back
      // through getAgentWorkflows and must be on the panel. On this box that is usually nothing,
      // and "nothing found" is a valid answer -- the assertion is that the answer is the host's.
      await page.evaluate(() => document.querySelectorAll("#panel-content details").forEach((d) => { d.open = true; }));
      const countBefore = ((await gw("getAgentWorkflows", { id: probeAgentId }).catch(() => [])) ?? []).length;
      await page.click("[data-port-local-skills]");
      const portToast = await until(() => page.evaluate(() => { const t = document.getElementById("toast")?.textContent ?? ""; return /Ported|Nothing ported|no local skill file/.test(t) ? t : null; }), 10_000, 400);
      const portedRows = ((await gw("getAgentWorkflows", { id: probeAgentId }).catch(() => [])) ?? []).filter((w) => w.source !== "automation");
      const portedOnPanel = await page.$$eval("[data-skill-id]", (els) => els.map((e) => e.dataset.skillId));
      check(portToast != null && portedRows.length >= countBefore && portedRows.every((w) => portedOnPanel.includes(w.id)), "Port reports the host's own answer and every skill it linked is listed", `${portToast?.slice(0, 80)} · ${portedRows.length} on host, ${portedOnPanel.length} on panel`);
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    }

    // -- Agent-owned skills beside global ones (qol/skills). Every skill used to be in one library
    // that every agent got, so a skill an agent wrote for itself during a turn was silently
    // everybody's and no surface could say whose it was. A skill now carries ownerAgentId: null is
    // global (what every skill was), an agent id is that agent's own and is offered to nobody else.
    // Two skills are written through the gateway -- one owned, one global -- and read back through
    // getAgentWorkflows for BOTH agents, because "not offered to the other one" is the whole claim
    // and only a second agent's list can prove it. Then the panel, which has to draw the split and
    // name the owner, and the operator's one-way "Make global". No model turn is spent.
    // The library sweep at the end of this gate removes both: they are on the probe's own list.
    if (probeAgentId) {
      const neighbour = (((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id !== probeAgentId && !a.isGroup) ?? null);
      const stamp = Date.now();
      const ownedName = `Gate owned skill ${stamp}`, globalName = `Gate global skill ${stamp}`;
      await gw("createAgentWorkflow", { id: probeAgentId, spec: { name: ownedName, description: "owned by the probe agent", body: "Reply with the single word: owned.", trigger: null, ownerAgentId: probeAgentId } }).catch((e) => check(false, "an owned skill could be written to the host", e.message));
      await gw("createAgentWorkflow", { id: probeAgentId, spec: { name: globalName, description: "in the box's library", body: "Reply with the single word: global.", trigger: null } }).catch((e) => check(false, "a global skill could be written to the host", e.message));
      const rowsFor = async (id) => ((await gw("getAgentWorkflows", { id }).catch(() => [])) ?? []);
      const mine = await rowsFor(probeAgentId);
      const ownedRow = mine.find((w) => w.name === ownedName) ?? null;
      const globalRow = mine.find((w) => w.name === globalName) ?? null;
      check(ownedRow?.ownerAgentId === probeAgentId, "a skill written for one agent records that agent as its owner", ownedRow ? String(ownedRow.ownerAgentId) : "not on the host");
      check(globalRow != null && globalRow.ownerAgentId == null, "and one written with no owner is global, the way every skill used to be", globalRow ? String(globalRow.ownerAgentId) : "not on the host");
      check(ownedRow != null && ownedRow.isEnabledForAgent !== false, "an owned skill is on for its owner from the moment it is saved");
      if (neighbour == null) check(false, "the box has a second agent to read the library through");
      else {
        const theirs = await rowsFor(neighbour.id);
        check(ownedRow != null && !theirs.some((w) => w.id === ownedRow.id), "another agent is not offered the owned skill", `${neighbour.name} sees ${theirs.length} skill(s)`);
        check(globalRow != null && theirs.some((w) => w.id === globalRow.id), "and is offered the global one");
      }
      await page.click("[data-capability='skills']");
      // The panel paints from the cached list first and repaints on its own read, so wait for the
      // card rather than for a clock.
      const painted = ownedRow == null ? null : await until(() => page.$(`[data-skill-id="${ownedRow.id}"]`), 15_000, 700);
      check(painted != null, "the Skills panel lists the owned skill for its owner");
      const sections = await page.$$eval(".skills-section-title", (els) => els.map((e) => e.textContent.trim()));
      check(sections.includes("This agent's skills") && sections.includes("Global skills"), "the Skills panel draws this agent's skills and the global ones as two sections", sections.join(" | "));
      if (ownedRow && globalRow) {
        const tagOf = (id) => page.evaluate((skillId) => document.querySelector(`[data-skill-id="${skillId}"] .skill-scope-tag`)?.textContent ?? "", id);
        const ownedTag = await tagOf(ownedRow.id), globalTag = await tagOf(globalRow.id);
        check(/^owned by \S/.test(ownedTag), "an owned card names its owner", ownedTag);
        check(/global/i.test(globalTag), "and a global card says it is every agent's", globalTag);
        // Make global: one click, read back through the OTHER agent's list, because the point of
        // the control is that the skill reaches agents whose panel is not on screen.
        const promote = `[data-skill-id="${ownedRow.id}"] [data-make-skill-global]`;
        check((await page.$(promote)) != null, "an owned skill offers Make global");
        check((await page.$(`[data-skill-id="${globalRow.id}"] [data-make-skill-global]`)) == null, "and a global one does not, since there is nothing to hand over");
        await page.click(promote);
        const reached = neighbour == null ? null : await until(async () => ((await rowsFor(neighbour.id)).some((w) => w.id === ownedRow.id) ? true : null), 12_000, 800);
        check(reached === true, "Make global puts the skill in every agent's library", neighbour ? `read back through ${neighbour.name}` : "no second agent");
      }
      // Escape does not cancel this dialog once the Make global click above has re-rendered the
      // card out from under the focused button: focus leaves #panel-dialog and the key goes
      // nowhere. The panel then holds its backdrop over #room-menu, so the click below spent 30s
      // timing out and everything after it -- the whole agent-details run, QOL-LOGOS, the panels
      // bleed sweep and the desktop-clipboard block at the end of this file -- never executed.
      // Close it the way an operator does, through the dialog's own x, and prove it shut. The
      // close() after the check is not part of the measurement: it keeps a failure here local
      // rather than taking the thousand lines below down with it.
      await page.click("#panel-dialog [data-close-dialog]", { timeout: 8000 }).catch(() => {});
      const skillsPanelClosed = await until(() => page.evaluate(() => (document.getElementById("panel-dialog")?.open ? null : true)), 5_000, 200);
      check(skillsPanelClosed === true, "the Skills panel closes on its own x button, leaving the room menu underneath it clickable");
      await page.evaluate(() => document.getElementById("panel-dialog")?.close());
      await page.waitForTimeout(500);
    }

    // -- MR-01, MR-05, MR-08, GW-06: the room ••• menu opens the live agent surface.
    const warmed = await screenWarm;
    if (warmed?.warmError) console.log(`  INFO  probe screen pre-warm failed: ${warmed.warmError}`);
    await page.click("#room-menu"); await page.waitForTimeout(1500);
    const panelTitle = await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent ?? "");
    check(/Agent details|Room roster/.test(panelTitle), "the room ••• button opens a live surface", panelTitle);
    const roleField = await page.$$("[data-save-role]");
    check(roleField.length === 1, "the Role row is editable rather than reading the words 'not set'");
    // 45s, not 25s: the cold allocation measured 27s, and the pre-warm above may still be racing
    // it if the probe turn came back quickly.
    const browserRow = await settled("[data-browser-screen]", /^Asking the host/, 45_000);
    check(browserRow != null, "the Agent details Browser row resolves to the host's answer, not the placeholder", browserRow ? browserRow.slice(0, 90) : "still 'Asking the host…' after 45s");
    const memoryList = await settled("[data-memory-list]", /^Reading /);
    check(memoryList != null, "the agent detail panel lists memories or says there are none", memoryList ? memoryList.slice(0, 90) : "still 'Reading…' after 25s");
    await noDemoStrings("agent details");

    // -- GW-01: the identity writes, on the probe agent whose panel is open, each read back from
    // the host rather than from the click.
    if (probeAgentId && /Agent details/.test(panelTitle)) {
      const rowOnHost = async () => ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === probeAgentId) ?? null;
      const renamed = `${probeName} renamed`;
      await page.fill(`[data-name-for="${probeAgentId}"]`, renamed);
      await page.fill(`[data-description-for="${probeAgentId}"]`, "renamed by the gate");
      await page.fill(`[data-role-for="${probeAgentId}"]`, "gate probe");
      await page.click("[data-save-role]");
      const saved = await until(async () => { const row = await rowOnHost(); return row && row.name === renamed && row.description === "renamed by the gate" && row.title === "gate probe" ? row : null; }, 10_000, 800);
      check(saved != null && callsTo("updateAgent") >= 1, "(a) name, description and role edits round-trip through updateAgent and listAgents", saved ? `${saved.name} · ${saved.description} · ${saved.title}` : JSON.stringify(await rowOnHost()));
      const rosterName = await until(() => page.evaluate((id) => { const t = document.querySelector(`[data-context-id="${id}"] .worker-name`)?.textContent ?? ""; return /renamed/.test(t) ? t : null; }, probeAgentId), 20_000, 1000);
      check(rosterName != null, "and the roster card follows the host's name on the next tick", rosterName ?? "");
      // (b) A 1×1 PNG through the avatar control. GET /avatars/<id> answered 404 before this; the
      // roster image must then carry the host's version, not a placeholder SVG.
      const avatarBefore = await fetch(`${GATEWAY}/avatars/${probeAgentId}`).then((r) => r.status).catch(() => null);
      await page.setInputFiles(`[data-avatar-for="${probeAgentId}"]`, { name: "dot.png", mimeType: "image/png", buffer: pngOf(1) });
      const served = await until(async () => { const r = await fetch(`${GATEWAY}/avatars/${probeAgentId}`); return r.status === 200 ? r.headers.get("content-type") : null; }, 10_000, 800);
      check(avatarBefore === 404 && served != null && callsTo("setAgentAvatarBytes") === 1, "(b) a 1×1 PNG through the avatar control makes GET /avatars/<id> answer 200", `before ${avatarBefore}, after ${served ?? "not served"}, ${callsTo("setAgentAvatarBytes")} write(s)`);
      const hostVersion = (await gw("getAgentAvatar", { id: probeAgentId }).catch(() => null))?.version ?? null;
      // AVATAR-1 changed what a roster card draws by default: a Titan crew member, not a picture
      // file. So an uploaded avatar is a choice on the record now, and the Character row in this
      // same panel is where it is made. The row rebuilds itself once the host holds an avatar,
      // because that is what puts "the picture uploaded to the host" in the list at all.
      const uploadedOption = await until(() => page.evaluate((id) => (document.querySelector(`[data-character-for="${id}"] option[value="uploaded"]`) ? true : null), probeAgentId), 15_000, 800);
      check(uploadedOption === true, "the Character row offers the uploaded picture once the host is holding one");
      await page.selectOption(`[data-character-for="${probeAgentId}"]`, "uploaded").catch(() => {});
      const rosterSrc = await until(() => page.evaluate((id) => { const src = document.querySelector(`[data-context-id="${id}"] img`)?.getAttribute("src") ?? ""; return /\/avatars\/.+\?v=/.test(src) ? src : null; }, probeAgentId), 20_000, 1000);
      check(hostVersion != null && rosterSrc != null && rosterSrc.includes(`?v=${encodeURIComponent(hostVersion)}`), "and choosing it puts the host's avatar version on the roster card", `${rosterSrc ?? "placeholder"} vs getAgentAvatar ${hostVersion}`);
      const characterOnHost = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === probeAgentId)?.avatarShape ?? null;
      check(characterOnHost === "titan:uploaded", "and the choice is on the host's profile, not in this browser", String(characterOnHost));
      // (c) notifications and hide-from-sidebar, then the hidden agent reached from the roster's
      // hidden group.
      await page.click(`[data-toggle-notify="${probeAgentId}"]`);
      const notifyOff = await until(async () => ((await rowOnHost())?.notifyOnUpdatesEnabled === false ? true : null), 10_000, 800);
      check(notifyOff === true && callsTo("setAgentNotifyOnUpdates") >= 1, "(c) the notifications toggle round-trips through setAgentNotifyOnUpdates and listAgents");
      await page.click(`[data-toggle-hidden="${probeAgentId}"]`);
      const hiddenOn = await until(async () => ((await rowOnHost())?.isHiddenFromSidebar === true ? true : null), 10_000, 800);
      check(hiddenOn === true && callsTo("setAgentHiddenFromSidebar") >= 1, "the hide-from-sidebar toggle round-trips through setAgentHiddenFromSidebar and listAgents");
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      const inHiddenGroup = await until(() => page.evaluate((id) => (document.querySelector(`[data-roster-hidden] [data-context-id="${id}"]`) ? true : null), probeAgentId), 15_000, 1000);
      check(inHiddenGroup === true, "a hidden agent moves to the roster's collapsed Hidden group instead of vanishing");
      if (inHiddenGroup) {
        // Idempotent: the group may already be open from an earlier arc, and a second click on the
        // summary would shut it and hide the very card this step is about.
        await openHiddenGroup();
        await page.click(`[data-roster-hidden] [data-context-id="${probeAgentId}"]`); await page.waitForTimeout(1500);
        check((await page.evaluate(() => document.getElementById("room-title")?.textContent)) === renamed, "and is still reachable from that group", await page.evaluate(() => document.getElementById("room-title")?.textContent));
      }
      await page.click("#room-menu"); await page.waitForTimeout(1200);
      await page.click(`[data-toggle-hidden="${probeAgentId}"]`);
      const hiddenOff = await until(async () => ((await rowOnHost())?.isHiddenFromSidebar === false ? true : null), 10_000, 800);
      check(hiddenOff === true, "and unhiding puts it back");
      // The avatar uploaded in (b) has to survive the identity writes in (c): each reads the row
      // back from listAgents, which reports avatarVersion null on this box, so a forgotten known
      // version reverted the roster image and the panel note to the placeholder (found by the
      // C2 verifier, 2026-09-03).
      await page.fill(`[data-description-for="${probeAgentId}"]`, "renamed by the gate, then saved again");
      await page.click("[data-save-role]");
      const resaved = await until(async () => ((await rowOnHost())?.description === "renamed by the gate, then saved again" ? true : null), 10_000, 800);
      check(resaved === true, "a profile save after the avatar upload still round-trips", resaved ? "" : "description not saved inside 10s");
      const rosterSrcAfter = await until(() => page.evaluate((id) => { const src = document.querySelector(`[data-context-id="${id}"] img`)?.getAttribute("src") ?? ""; return /\/avatars\/.+\?v=/.test(src) ? src : null; }, probeAgentId), 10_000, 800);
      const noteAfter = await page.evaluate(() => document.querySelector("[data-avatar-note]")?.textContent ?? "");
      check(rosterSrcAfter === rosterSrc && /serves this agent's own avatar/.test(noteAfter), "the avatar survives the rename, notifications and hide writes that followed it", `roster ${rosterSrcAfter ?? "placeholder"}; note "${noteAfter.slice(0, 60)}"`);
      // (d) Duplicate, then delete the copy through the panel's two-click Delete (deleteAgents).
      const knownIds = new Set(((await gw("listAgents").catch(() => [])) ?? []).map((a) => a.id));
      await page.click(`[data-duplicate-agent="${probeAgentId}"]`);
      const copy = await until(async () => ((await gw("listAgents").catch(() => [])) ?? []).find((a) => !knownIds.has(a.id)) ?? null, 20_000, 1000);
      copyAgentId = copy?.id ?? null;
      check(copy != null && copy.name === `${renamed} copy` && callsTo("duplicateAgent") === 1, "(d) Duplicate creates a copy on the host through duplicateAgent", copy ? copy.name : "no new agent inside 20s");
      if (copyAgentId) {
        // The host has the copy before the roster draws it: measured on this box the new card
        // appears about 6.5 s after duplicateAgent answers, and the old fixed 1.5 s wait clicked a
        // card that was not there yet. The click swallowed its own failure, so the panel stayed on
        // the previous agent and the copy's Delete button was waited for until the gate timed out.
        // Wait for the card the operator would click, and say so when it never arrives.
        const copyCard = await until(() => page.evaluate((id) => !!document.querySelector(`[data-context-id="${id}"]`) || null, copyAgentId), 30_000, 1000);
        check(copyCard === true, "the copy appears in the roster the operator is looking at", copyCard ? "" : "no card for the copy inside 30s");
        // That same re-render closes the open panel dialog, and a click landing inside it selects
        // nothing: measured on this box with a scripted repro, the active card stayed on the
        // previous agent, so #room-menu opened THAT agent's details and the copy's Delete button
        // was never drawn -- 30 s of waiting for a button belonging to a panel that was not open.
        // Click until the copy is the card the console is actually showing.
        const selectedCopy = await until(async () => {
          await page.click(`[data-context-id="${copyAgentId}"]`).catch(() => {});
          await page.waitForTimeout(1200);
          return page.evaluate((id) => (document.querySelector(".worker-card.is-active")?.getAttribute("data-context-id") === id ? true : null), copyAgentId);
        }, 20_000, 800);
        check(selectedCopy === true, "clicking the copy's roster card makes it the agent on screen", selectedCopy ? "" : "the copy never became the active card inside 20s");
        await page.click("#room-menu"); await page.waitForTimeout(1200);
        await page.click(`[data-delete-agent="${copyAgentId}"]`); await page.waitForTimeout(300);
        const armed = await page.evaluate((id) => document.querySelector(`[data-delete-agent="${id}"]`)?.textContent, copyAgentId);
        const stillThere = ((await gw("listAgents").catch(() => [])) ?? []).some((a) => a.id === copyAgentId);
        check(armed === "Confirm" && stillThere, "deleting an agent arms on the first click and deletes nothing");
        await page.click(`[data-delete-agent="${copyAgentId}"]`);
        const gone = await until(async () => (((await gw("listAgents").catch(() => null)) ?? []).some((a) => a.id === copyAgentId) ? null : true), 15_000, 1000);
        check(gone === true && callsTo("deleteAgents") === 1, "and the second click deletes it on the host through deleteAgents");
        if (gone) copyAgentId = null;
      }
      // (e) The roster header. AGENTS-CAP-2 and GATE-15: this used to assert the literal `/ 100
      // bots` (and the Add button `of 12`, which had already gone stale and was a second copy of
      // the same bug). The ceiling is per workspace now -- the super admin raises one from its
      // client row by writing SAND_MAX_AGENTS into that box -- so no literal is right for every box
      // this gate is pointed at, and editing the literal would only move the bug to the next
      // decision. The gate asks the BOX what its ceiling is and requires the console to agree.
      //
      // The number drawn is the bots on the box, NOT countAgents: countAgents counts a room as an
      // agent and the cap does not, so pinning the two together would pin a number that disagrees
      // with the ceiling beside it. The host's own count is read anyway and reported in the detail,
      // because when the two differ by anything other than the rooms on screen that is worth
      // seeing in the log.
      const hostCount = await gw("countAgents").catch(() => null);
      const capacity = await gw("getAgentCapacity").catch(() => null);
      const ceiling = Number(capacity?.maxAgents);
      check(Number.isInteger(ceiling) && ceiling > 0, "(e) the box reports the ceiling it will refuse at",
        capacity == null ? "getAgentCapacity did not answer" : `maxAgents ${capacity.maxAgents}, ${capacity.bots} bots, ${capacity.remaining} left`);
      const shownCount = Number.isInteger(ceiling) && ceiling > 0
        ? await until(() => page.evaluate((max) => { const el = document.querySelector("[data-agent-count]"); return el && !el.hidden && new RegExp(`^\\d+ / ${max} bots$`).test(el.textContent.trim()) ? el.textContent.trim() : null; }, ceiling), 25_000, 1500)
        : null;
      const botCards = await page.$$eval(".worker-card:not(.room-card)", (els) => els.length).catch(() => -1);
      check(shownCount != null, "(e) the roster header shows this box's bots against the ceiling the box reports", `${shownCount ?? await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent)} against maxAgents ${ceiling}, vs host countAgents ${hostCount}`);
      check(shownCount != null && Number(shownCount.split(" ")[0]) === botCards, "(e) and that number is the bot cards on screen, with the rooms left out", `header ${shownCount}, ${botCards} bot card(s)`);
      // The Add button carries what is left beside Titan, before anyone clicks it: the same ceiling
      // less the one seat Titan holds.
      const addCount = await page.evaluate(() => document.querySelector('[data-capability="add"] [data-add-count]')?.textContent?.trim() ?? "");
      check(Number.isInteger(ceiling) && new RegExp(`^\\d+ of ${ceiling - 1}$`).test(addCount) && Number(addCount.split(" ")[0]) === Math.max(0, botCards - 1), "(e) the Add button says how many of the seats beside Titan are taken", `${addCount || "empty"} against a ceiling of ${ceiling}`);
      await page.waitForTimeout(300);
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);

    // -- MARKET-1: the Marketplace. Two pill tabs, the host's own catalog on the Plugins tab, and
    // no provider anywhere inside it: providers and chat listeners moved to Settings this wave,
    // which is the whole point of it ("I really don't want providers in this marketplace area").
    await openMarketplace();
    const tabs = await page.$$eval("[data-marketplace-tabs] .roster-tab", (els) => els.map((e) => `${e.textContent.trim()}${e.classList.contains("is-active") ? "*" : ""}`));
    check(tabs.join(",") === "Plugins*,Bots", "the Marketplace opens on the Plugins tab, beside a Bots tab", tabs.join(", ") || "no tabs");
    // The catalog is read from the host, not restated here: source/shared/marketplace/catalog.ts is
    // where it is fixed, and the whole contract is that the console and the agents' plugin tools
    // resolve against the same rows. A host without the command yet gets an INFO line, because the
    // derivations behind this page are pinned in tests/machine-room-marketplace.test.mjs.
    const catalog = await gw("listMarketplace", {}).catch(() => null);
    const catalogPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
    if (catalogPlugins.length === 0) {
      console.log("  INFO  listMarketplace answers no plugins on this host yet — the catalog cards, chips and search are covered by tests/machine-room-marketplace.test.mjs until it lands");
      const note = await page.evaluate(() => document.querySelector("[data-marketplace-note]")?.textContent ?? "");
      check(/no marketplace catalog|no gateway behind it/.test(note), "and the tab says the host serves none instead of drawing an empty catalog", note.slice(0, 120));
    } else {
      const cards = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
      const missingCards = catalogPlugins.map((plugin) => String(plugin.id)).filter((id) => !cards.includes(id));
      check(missingCards.length === 0, `every plugin in the host's catalog has a card (${catalogPlugins.length})`, missingCards.length ? `missing ${missingCards.join(", ")}` : cards.join(", "));
      const chips = await page.$$eval("[data-marketplace-chips] [data-marketplace-category]", (els) => els.map((e) => e.dataset.marketplaceCategory));
      // categories is { plugins, bots } on this host; the Plugins tab's chips are the plugins half.
      const catalogCategories = (Array.isArray(catalog.categories) ? catalog.categories : (catalog.categories?.plugins ?? [])).map(String);
      const wantedChips = ["All", ...catalogCategories].filter((name, i, all) => all.indexOf(name) === i);
      const missingChips = wantedChips.filter((name) => !chips.includes(name));
      check(missingChips.length === 0, `the category chips are the catalog's own (${chips.length})`, missingChips.length ? `missing ${missingChips.join(", ")}` : chips.join(", "));
      // A chip filters to its own category and nothing else. Featured is skipped: it is a flag on
      // the row, not a category, and it is asserted by the card coverage above.
      const pickCategory = catalogCategories.find((name) => name !== "Featured" && catalogPlugins.some((plugin) => String(plugin.category) === name)) ?? null;
      if (pickCategory) {
        await page.click(`[data-marketplace-category="${pickCategory}"]`); await page.waitForTimeout(600);
        const filtered = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
        const expected = catalogPlugins.filter((plugin) => String(plugin.category) === pickCategory).map((plugin) => String(plugin.id));
        check(filtered.slice().sort().join(",") === expected.slice().sort().join(","), `the ${pickCategory} chip shows that category and nothing else`, `${filtered.join(", ")} vs ${expected.join(", ")}`);
        await page.click(`[data-marketplace-category="All"]`); await page.waitForTimeout(600);
      }
      // Search is the same rule the catalog's own SearchPlugins tool applies -- name, tagline,
      // category -- because there is one catalog and it has to give one answer.
      const probe = String(catalogPlugins[0].name).slice(0, 4);
      await page.fill("#marketplace-search", probe); await page.waitForTimeout(700);
      // Deduped defensively. QOL-LOGOS made a card land on the page once -- the category section
      // keeps it and Featured yields -- so each id appears once; the Set is what makes this line
      // survive either rule rather than a claim about which one is in force.
      const found = [...new Set(await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard)))];
      const wanted = catalogPlugins
        .filter((plugin) => [plugin.name, plugin.tagline, plugin.category].some((field) => String(field ?? "").toLowerCase().includes(probe.toLowerCase())))
        .map((plugin) => String(plugin.id));
      check(found.slice().sort().join(",") === wanted.slice().sort().join(","), `searching "${probe}" narrows the catalog to what matches`, `${found.join(", ")} vs ${wanted.join(", ")}`);
      await page.fill("#marketplace-search", ""); await page.waitForTimeout(700);
      // The Bots tab is the other half of this wave. What this gate owns is the contract between
      // them: the tab exists and hands that half a container to draw into.
      await page.click('[data-marketplace-tab="bots"]'); await page.waitForTimeout(900);
      check((await page.$$("#marketplace-bots")).length === 1, "the Bots tab renders the container the bot templates are drawn into");
      await page.click('[data-marketplace-tab="plugins"]'); await page.waitForTimeout(900);
    }
    const inMarket = await page.$$eval("[data-marketplace] [data-plugin-id]", (els) => els.map((e) => e.dataset.pluginId));
    check(!inMarket.some((id) => id.startsWith("sub:")), "no provider card appears in the Marketplace", inMarket.join(", ") || "nothing installed on this box");
    check(inMarket.every((id) => id.startsWith("mcp:") || id.startsWith("shell:")), "and every card in it is a connector or a shell tool", inMarket.join(", "));
    check((await page.$$("[data-marketplace] [data-channel-state]")).length === 0, "and no chat listener either");

    // -- QOL-LOGOS: one tile, one size, a real logo where the catalog names one, and a card that
    // holds its own contents. The sizes are the contract: 40px on a card and in the installed
    // strip, 64px on the plugin page, the image inside with 6px of padding and object-fit:
    // contain. The image is a FILE in this repo under ui/machine-room/marketplace/logos/, served
    // by the relay out of the console's own directory -- so naturalWidth > 0 also says the relay
    // still serves it, which is the half of this that a unit test cannot reach.
    if (catalogPlugins.length > 0) {
      const withLogo = catalogPlugins.filter((plugin) => typeof plugin?.icon?.file === "string" && plugin.icon.file.length > 0);
      const tiles = await page.evaluate(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }; };
        const read = (selector, where) => [...document.querySelectorAll(selector)].map((el) => ({ where, id: el.closest("[data-marketplace-card]")?.dataset.marketplaceCard ?? el.dataset.pluginId ?? "", ...rect(el) }));
        return [...read("[data-marketplace-card] .marketplace-tile", "card"), ...read("[data-marketplace-installed] .marketplace-tile", "strip")];
      });
      const offSize = tiles.filter((tile) => Math.abs(tile.w - 40) > 0.5 || Math.abs(tile.h - 40) > 0.5);
      check(tiles.length > 0 && offSize.length === 0, `every marketplace tile is the standard 40px square (${tiles.length})`,
        offSize.length ? offSize.map((tile) => `${tile.where}:${tile.id} ${tile.w}x${tile.h}`).join(", ") : "cards and installed strip");
      // A logo that 404s, or one the catalog names with a path the console refuses, leaves the
      // letter tile behind: naturalWidth is what tells those two apart from a drawn image. The
      // logo lives in the CATALOG, which ships inside the host bundle, so a box still running a
      // pre-QOL-LOGOS bundle names none -- that is an INFO about what is deployed, not a red row
      // about the console, and the paths themselves are held by tests/marketplace-logos.test.mjs.
      if (withLogo.length === 0) {
        console.log("  INFO  the catalog on this box names no icon.file yet — rebuild and deploy the host bundle before reading the logo rows as green");
      } else {
        const logos = await page.evaluate(() => [...document.querySelectorAll("[data-marketplace-card] .marketplace-tile-img")]
          .map((img) => ({ id: img.closest("[data-marketplace-card]")?.dataset.marketplaceCard ?? "", src: img.getAttribute("src"), natural: img.naturalWidth })));
        const drawn = new Map(logos.map((logo) => [logo.id, logo]));
        const badLogos = withLogo.map((plugin) => {
          const logo = drawn.get(String(plugin.id));
          if (logo == null) return `${plugin.id}: no <img> on the card`;
          if (logo.src !== plugin.icon.file) return `${plugin.id}: card draws ${logo.src}, catalog says ${plugin.icon.file}`;
          return logo.natural > 0 ? null : `${plugin.id}: ${logo.src} did not load`;
        }).filter(Boolean);
        check(badLogos.length === 0, `every plugin the catalog gives a logo draws it, loaded (${withLogo.length})`,
          badLogos.length ? badLogos.join("; ") : withLogo.map((plugin) => plugin.id).join(", "));
      }
      // Nothing on a card may stick out of it: the "✓ Added" pill clipped at the right edge is
      // exactly what this catches, and so is a tagline that grows the card instead of truncating.
      const spills = await page.evaluate(() => [...document.querySelectorAll("[data-marketplace-card]")].flatMap((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll("*")]
          .filter((kid) => { const k = kid.getBoundingClientRect(); return k.width > 0 && (k.right > box.right + 0.5 || k.left < box.left - 0.5 || k.bottom > box.bottom + 0.5 || k.top < box.top - 0.5); })
          .map((kid) => `${card.dataset.marketplaceCard}:${kid.className || kid.tagName}`);
      }));
      check(spills.length === 0, "and no card overflows its own bounds", spills.slice(0, 6).join(", ") || "every card contains its tile, copy and button");
      const clipped = await page.evaluate(() => [...document.querySelectorAll("[data-marketplace-card] .marketplace-card-action")]
        .filter((el) => el.scrollWidth > el.clientWidth).map((el) => `${el.closest("[data-marketplace-card]").dataset.marketplaceCard} "${el.textContent.trim()}"`));
      check(clipped.length === 0, "the Add button and the ✓ Added pill are drawn whole, not clipped", clipped.join(", ") || "nothing shrunk to a clip");
      // A card once on the page, and no heading emptied to get there. The category section keeps
      // every member and Featured yields to it, so under All the headings are the catalog's own
      // categories -- the other way round dropped four of them, because five of ten plugins are
      // featured and four categories have no other member. The Featured chip is what draws the
      // Featured section, and it draws all of them.
      const drawnIds = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
      const twice = drawnIds.filter((id, i) => drawnIds.indexOf(id) !== i);
      check(twice.length === 0, "and a card is drawn once, not once under Featured and again under its category", [...new Set(twice)].join(", ") || `${drawnIds.length} cards, ${new Set(drawnIds).size} plugins`);
      const headings = await page.$$eval("[data-marketplace-sections] .plugin-group-title", (els) => els.map((e) => e.textContent.trim()));
      const inUse = [...new Set(catalogPlugins.map((plugin) => String(plugin.category ?? "")).filter(Boolean))];
      const missingHeads = inUse.filter((category) => !headings.includes(category));
      check(missingHeads.length === 0, `and under All every category the catalog uses keeps its heading (${inUse.length})`,
        missingHeads.length ? `missing ${missingHeads.join(", ")}` : headings.join(" | "));
      const featuredIds = catalogPlugins.filter((plugin) => plugin.featured === true).map((plugin) => String(plugin.id));
      const withCategory = featuredIds.find((id) => catalogPlugins.some((plugin) => String(plugin.id) === id && String(plugin.category ?? "") !== "Featured")) ?? null;
      if (withCategory) {
        const category = String(catalogPlugins.find((plugin) => String(plugin.id) === withCategory).category);
        const underCategory = await page.evaluate((name) => {
          const title = [...document.querySelectorAll("[data-marketplace-sections] .plugin-group-title")].find((el) => el.textContent.trim() === name);
          return title == null ? [] : [...(title.nextElementSibling?.querySelectorAll("[data-marketplace-card]") ?? [])].map((el) => el.dataset.marketplaceCard);
        }, category);
        check(underCategory.includes(withCategory), `and the ${category} section lists ${withCategory} in the default view rather than losing it to Featured`, underCategory.join(", ") || `nothing under ${category}`);
        await page.click(`[data-marketplace-category="Featured"]`); await page.waitForTimeout(600);
        const underFeatured = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
        check(featuredIds.every((id) => underFeatured.includes(id)) && underFeatured.length === featuredIds.length,
          `and the Featured chip draws every featured plugin (${featuredIds.length})`, `${underFeatured.join(", ")} vs ${featuredIds.join(", ")}`);
        await page.click(`[data-marketplace-category="All"]`); await page.waitForTimeout(600);
      }
      // The plugin page's tile is the same tile at the page size. Opened and closed here rather
      // than folded into the Add flow below, which uninstalls what it opens.
      const heroId = withLogo.length ? String(withLogo[0].id) : String(catalogPlugins[0].id);
      await page.click(`[data-marketplace-plugin="${heroId}"]`, { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(900);
      const hero = await page.evaluate(() => {
        const tile = document.querySelector(".plugin-hero .marketplace-tile");
        if (tile == null) return null;
        const r = tile.getBoundingClientRect();
        const img = tile.querySelector(".marketplace-tile-img");
        return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, src: img?.getAttribute("src") ?? null, natural: img?.naturalWidth ?? 0 };
      });
      check(hero != null && Math.abs(hero.w - 64) <= 0.5 && Math.abs(hero.h - 64) <= 0.5,
        `the ${heroId} plugin page draws the same tile at 64px`, hero ? `${hero.w}x${hero.h}` : "no tile on the plugin page");
      if (withLogo.length > 0) check(hero != null && hero.natural > 0, "with its logo loaded on it", hero ? `${hero.src ?? "letter tile"} natural ${hero.natural}` : "no tile");
      await page.click("[data-marketplace-back]").catch(() => {});
      await page.waitForTimeout(700);
    }

    // -- MR-02: the box's real server, its real tools and its real status, on its plugin page.
    await pickPlugin("mcp:localfiles");
    // Against the host's own number, never a literal: connectors.json launches this server with
    // `npx -y @modelcontextprotocol/server-filesystem`, unpinned, so the upstream release that
    // adds or drops a tool would otherwise turn this gate red for a reason outside the dashboard.
    const boxServers = await gw("listBoxMcpServers", { serverIdentifiers: ["localfiles"] }).catch(() => null);
    const expectedTools = (boxServers?.servers ?? []).find((s) => s.serverIdentifier === "localfiles")?.toolCount ?? 0;
    const toolRows = await page.$$eval(".plugin-detail .tool-row strong", (els) => els.map((e) => e.textContent.trim()));
    check(expectedTools > 0 && toolRows.length === expectedTools, `the localfiles connector shows every tool the host reports for it (${expectedTools})`, `${toolRows.length} rows: ${toolRows.slice(0, 3).join(", ")}`);
    const toolsHeading = await page.evaluate(() => Array.from(document.querySelectorAll(".plugin-section-title")).map((e) => e.textContent.replace(/\s+/g, " ").trim()).join(" | "));
    check(expectedTools > 0 && new RegExp(`${expectedTools}/${expectedTools} enabled`).test(toolsHeading), "the Tools heading counts the real rows", toolsHeading.slice(0, 120));
    // MR-02/L: the connector card must not echo the box's MCP command line -- connectors.json is
    // the 0600 file that carries connector tokens, and argv is where an --api-key lands.
    const connectorSpec = await relay("/connectors").then((c) => c?.mcpServers?.localfiles ?? null).catch(() => null);
    // Scoped to the card's own hero copy: a server's tool descriptions are the server's words and
    // may legitimately name a path, but the card's description is ours and is built from the spec.
    // The hero carries the CATALOG's description for a plugin the catalog knows; the card's own
    // line -- the one built from connectors.json, and the one that must never echo argv -- is the
    // server row in the Connectors box.
    const connectorBlurb = await page.evaluate(() => document.querySelector("[data-connector-status] small")?.textContent ?? "");
    const argLeaks = [...(connectorSpec?.args ?? []), ...Object.values(connectorSpec?.env ?? {})].filter((v) => String(v).length > 2 && connectorBlurb.includes(String(v)));
    check(argLeaks.length === 0, "the connector card names the executable without echoing its argv or env", `blurb: ${connectorBlurb.slice(0, 110)}`);
    check(/argument\(s\), configured in connectors\.json/.test(connectorBlurb), "and says where the rest of the launch spec lives", connectorBlurb.slice(0, 110));
    const skillsHeading = await page.evaluate(() => Array.from(document.querySelectorAll(".plugin-section-title")).some((e) => /Skills in package/.test(e.textContent)));
    check(skillsHeading === false, "no empty Skills heading over an empty div");

    // -- Wave D1 (CP-03, CP-09, CP-10 item 1, CP-11): the connector plane. The host half of this
    // wave lands separately, so each block is guarded on the command actually being there: a host
    // that answers "unknown gateway method" gets an INFO line and the Wave B read-only card is
    // what must still be on screen. tests/machine-room-connectors.test.mjs pins the same paths
    // against a stub gateway so they are covered before the host arrives.
    const hasCommand = async (method, args = {}) => {
      try { await gw(method, args); return true; } catch (error) { return !/unknown gateway method/.test(error.message); }
    };
    const installedHere = await hasCommand("listInstalledMcpServers");
    if (!installedHere) {
      console.log("  INFO  listInstalledMcpServers is not on this host yet — the numeric-id card, the tool switch and the connector key form are covered by tests/machine-room-connectors.test.mjs until it lands");
      const readOnly = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
      check(/numeric server id/.test(readOnly) && (await page.$$(".plugin-detail [data-toggle-tool]")).length === 0,
        "without the host half the connector card stays the read-only Wave B card", readOnly.slice(0, 110));
    } else {
      const installed = await gw("listInstalledMcpServers", {}).catch(() => null);
      const server = (Array.isArray(installed) ? installed : []).find((row) => row?.name === "localfiles") ?? null;
      check(server != null && server.id != null, "the host installs localfiles with an id of its own", `id ${server?.id}`);
      await pickPlugin("mcp:localfiles");
      const idBlurb = await page.evaluate(() => document.querySelector("[data-connector-status] small")?.textContent ?? "");
      check(server != null && idBlurb.includes(`host id ${server.id}`), "the localfiles card shows the host's numeric server id", idBlurb.slice(0, 120));
      const hostTools = server ? await gw("listMcpServerTools", { serverId: server.id }).catch(() => null) : null;
      const switches = await page.$$eval(".plugin-detail .tool-row [data-toggle-tool]", (els) => els.map((e) => e.dataset.toggleTool));
      check(Array.isArray(hostTools) && switches.length === hostTools.length && switches.length > 0,
        `every tool the host lists for localfiles is a switch (${Array.isArray(hostTools) ? hostTools.length : "?"})`, `${switches.length} switch(es)`);
      // CP-03: the row moves because the host moved, not because the switch was clicked. Read the
      // host's own list back, then flip it home so the box is left as the gate found it.
      if (Array.isArray(hostTools) && hostTools.length > 0 && switches.length > 0) {
        const first = hostTools[0].name;
        const before = hostTools[0].enabled !== false;
        await page.click(`.plugin-detail [data-toggle-tool="${switches[0]}"]`); await page.waitForTimeout(2500);
        const rowAfter = await page.evaluate((sel) => document.querySelector(`[data-toggle-tool="${sel}"]`)?.getAttribute("aria-pressed") ?? "", switches[0]);
        const hostAfter = await gw("listMcpServerTools", { serverId: server.id }).catch(() => null);
        const hostRow = (Array.isArray(hostAfter) ? hostAfter : []).find((t) => t.name === first) ?? null;
        check(hostRow != null && (hostRow.enabled !== false) === !before, `flipping ${first} changed the host's own tool list`, `${before} → ${hostRow?.enabled}`);
        check(rowAfter === String(!before), "and the switch on the card followed the host, not the click", `aria-pressed ${rowAfter}`);
        await page.click(`.plugin-detail [data-toggle-tool="${switches[0]}"]`).catch(() => {}); await page.waitForTimeout(2500);
        const restored = ((await gw("listMcpServerTools", { serverId: server.id }).catch(() => [])) ?? []).find((t) => t.name === first) ?? null;
        check(restored != null && (restored.enabled !== false) === before, `${first} is left as the gate found it`, `${restored?.enabled}`);
      }
      // CP-10 item 1: the key form exists on this card and names the environment values the
      // connector wants -- but nothing is SUBMITTED here. setConnectorSecret stores the value and
      // restarts the connector, and localfiles is the box's one working MCP server that other
      // gates depend on; a probe value would go into its real environment. The submit is done
      // below, on the throwaway connector this gate adds and removes.
      // CONNECT-4: only the env keys the entry leaves EMPTY are credentials. A key with a value is
      // configuration the operator already answered, and the card must not offer it -- that is how
      // MCP_REMOTE_CONFIG_DIR, a directory path, came up captioned "Enter securely".
      const declared = await relay("/connectors")
        .then((c) => Object.entries(c?.mcpServers?.localfiles?.env ?? {}).flatMap(([name, value]) => value === "" ? [name] : []))
        .catch(() => []);
      const held = await gw("listConnectorSecretFields", { server: "localfiles" }).catch(() => null);
      const formFields = await page.$$eval("[data-connector-secret-form] input[type=password]", (els) => els.map((e) => e.name));
      const expectedFields = [...new Set([...declared, ...(held?.fields ?? [])])];
      // No short-circuit on an empty expected set: on a box whose localfiles entry declares no
      // empty-valued env key, "the form offers nothing" IS the CONNECT-4 assertion, and letting
      // it pass on length 0 is what made this line observe the negative case without checking it.
      check(formFields.sort().join(",") === expectedFields.sort().join(","),
        `the key form names every environment value localfiles wants (${expectedFields.length})`, `form ${formFields.join(", ")} vs ${expectedFields.join(", ")}`);
      const envValues = await relay("/connectors").then((c) => Object.values(c?.mcpServers?.localfiles?.env ?? {})).catch(() => []);
      const formHtml = await page.evaluate(() => document.querySelector("[data-connector-secret-form]")?.outerHTML ?? "");
      check(!envValues.filter((v) => String(v).length > 2).some((v) => formHtml.includes(String(v))), "and carries no value from connectors.json into its markup");
    }

    // -- CP-11: the connectors editor. The relay's /connectors route and refreshMcp both answer
    // today, so this runs on every host. A stdio server the box can actually launch: node with a
    // one-file MCP server written into /workspace, the same shape connectors.json already holds.
    // Back to the list first: the editor is on the Plugins tab's list view, and the connector
    // checks above left that connector's own plugin page open in front of it.
    await page.click("[data-marketplace-back]").catch(() => {});
    await page.waitForTimeout(800);
    const editor = await page.$("[data-connector-editor]");
    if (!editor) check(false, "the Plugins tab offers a connectors editor");
    else {
      const before = await relay("/connectors").catch(() => null);
      const wrote = await box(`cat > /workspace/${PROBE_MCP_FILE} <<'PROBEEOF'\n${PROBE_MCP_SOURCE}\nPROBEEOF`);
      check(wrote.code === 0, "the gate can write its probe MCP server into /workspace", wrote.out.slice(0, 120));
      // Opened rather than clicked: a click toggles, and a run that reached this block with the
      // disclosure already open would close it and then fail to fill an invisible field.
      await page.evaluate(() => document.querySelector("[data-connector-editor]")?.setAttribute("open", "open"));
      await page.waitForTimeout(400);
      // -- CONNECT-3, then the connectors wave: the preset catalog. One click per preset has to
      // fill that entry exactly, and NOTHING is saved here: this gate must not put a connector
      // pointing at agent.tinyfish.ai, api.githubcopilot.com, Slack, Linear or Google on a shared
      // box. The round trip belongs to scripts/verify-connector-plane.mjs --tinyfish-key, which
      // runs the same shape against a stub MCP server inside the box.
      //
      // The expectations come from the console's own catalog (window.__connectorPresets) rather
      // than from constants restated here, because the entries themselves are fixed elsewhere:
      // tests/connector-preset-catalog.test.mjs holds each one against the JSON in its report
      // under docs/connectors/. What this gate proves is the half no unit test can — that a real
      // browser click puts that entry, character for character, into the four fields.
      const catalog = await page.evaluate(() => (window.__connectorPresets ?? []).map((p) => ({
        id: p.id, label: p.label, name: p.name, command: p.entry.command, argsText: p.argsText,
        envNames: Object.keys(p.entry.env),
        // CONNECT-4's rule: an env key the entry leaves EMPTY is a credential, and a credential is
        // what has to arrive with a hint saying where it comes from.
        credentials: Object.entries(p.entry.env).flatMap(([name, value]) => (value === "" ? [name] : [])),
        hints: p.hints ?? {},
      })));
      check(catalog.length >= 5, `the connector editor carries a preset catalog (${catalog.length})`, catalog.map((p) => p.id).join(", "));
      for (const preset of catalog) {
        const button = await page.$(`[data-connector-preset="${preset.id}"]`);
        check(button != null, `the connector editor offers the ${preset.label} preset`);
        if (!button) continue;
        const label = (await page.evaluate((id) => document.querySelector(`[data-connector-preset="${id}"]`)?.textContent ?? "", preset.id)).trim();
        check(label === preset.label, `and the ${preset.id} button is named for the recipe it fills`, label);
        await button.click(); await page.waitForTimeout(300);
        const filled = await page.evaluate(() => ({
          name: document.querySelector("#connector-name")?.value ?? "",
          command: document.querySelector("#connector-command")?.value ?? "",
          args: document.querySelector("#connector-args")?.value ?? "",
          env: document.querySelector("#connector-env")?.value ?? "",
          hints: document.querySelector("[data-connector-preset-hints]")?.textContent ?? "",
        }));
        check(filled.name === preset.name && filled.command === preset.command,
          `clicking it fills ${preset.id}'s name and command`, `${filled.name} · ${filled.command}`);
        // A bearer header is one argument with a space in it, so the field has to carry it quoted;
        // an unquoted one would arrive as two arguments and the header would be lost.
        check(filled.args === preset.argsText, `and ${preset.id}'s arguments, with any header quoted whole`, filled.args);
        check(filled.env === preset.envNames.join(", "), `and names the environment values ${preset.id} wants`, filled.env);
        // Named, and said out loud: a field with no line telling the operator what it is and where
        // it is made sends them to the service's docs to find out, which is the whole gap here.
        const unexplained = preset.credentials.filter((name) => !preset.hints[name] || !filled.hints.includes(preset.hints[name]));
        check(unexplained.length === 0,
          `and says what each credential ${preset.id} wants is and where it comes from (${preset.credentials.length})`, unexplained.join(", "));
      }
      const afterPreset = await relay("/connectors").catch(() => null);
      check(JSON.stringify(afterPreset?.mcpServers ?? null) === JSON.stringify(before?.mcpServers ?? null),
        "and every one of those clicks wrote nothing to connectors.json", Object.keys(afterPreset?.mcpServers ?? {}).join(", "));
      await page.fill("#connector-name", PROBE_CONNECTOR);
      await page.fill("#connector-command", "node");
      await page.fill("#connector-args", `/workspace/${PROBE_MCP_FILE}`);
      await page.fill("#connector-env", "PROBE_TOKEN");
      probeConnectorAdded = true;
      await page.click("[data-add-connector] button[type=submit]"); await page.waitForTimeout(6000);
      const file = await relay("/connectors").catch(() => null);
      const spec = file?.mcpServers?.[PROBE_CONNECTOR] ?? null;
      check(spec?.command === "node", "the editor wrote the probe connector into connectors.json", JSON.stringify(spec ?? null).slice(0, 120));
      // Env NAMES only: connectors.json is the 0600 plaintext file, so a value must never be
      // written there by this form. The key form on the card is where a value goes.
      check(spec != null && Object.values(spec.env ?? {}).every((v) => v === ""), "with the environment variable named and no value written into that file", JSON.stringify(spec?.env ?? null));
      check(Object.keys(before?.mcpServers ?? {}).every((name) => file?.mcpServers?.[name]), "and the connectors already on the box survived the write");
      // refreshMcp is what makes it appear without an operator docker exec. The host relaunches
      // its stdio servers, so give it a beat and then read the card the page draws for it.
      const connected = await until(async () => {
        const servers = await gw("listBoxMcpServers", { serverIdentifiers: [PROBE_CONNECTOR] }).catch(() => null);
        const row = (servers?.servers ?? []).find((row2) => row2.serverIdentifier === PROBE_CONNECTOR) ?? null;
        return row && row.status === "connected" ? row : null;
      }, 45_000, 3000);
      check(connected != null, "and the host connects it after refreshMcp, with no docker exec", connected ? `status ${connected.status}, ${connected.toolCount} tool(s)` : "never reached connected");
      // Reopened after the wait so the panel is drawn from the state the host reports NOW: the
      // render right after the POST ran before the box had finished launching the process.
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      await openMarketplace(); await page.waitForTimeout(1500);
      // Read the card until it agrees with the host, don't read it once. refreshMcp relaunches the
      // box's stdio servers, so a server that reported connected a moment ago can be back in
      // "initializing" by the time the panel draws -- measured on grok-bot-local-vm 2026-09-07,
      // "The box reports this server as initializing ... 0 tool(s) discovered", one run in two.
      // The assertion is that the card says what the host says, and that is what this waits for.
      let probeName = "";
      let probeCard = "";
      const cardBy = Date.now() + 25_000;
      do {
        await pickPlugin(`mcp:${PROBE_CONNECTOR}`).catch(() => {});
        probeName = await page.evaluate(() => document.querySelector(".plugin-detail h3")?.textContent ?? "");
        probeCard = await page.evaluate(() => document.querySelector(".plugin-detail .plugin-hero-copy p")?.textContent ?? "");
        if (probeName === PROBE_CONNECTOR && (connected == null || /connected/.test(probeCard))) break;
        await page.waitForTimeout(2500);
        await page.keyboard.press("Escape"); await page.waitForTimeout(300);
        await openMarketplace(); await page.waitForTimeout(1200);
      } while (Date.now() < cardBy);
      check(probeName === PROBE_CONNECTOR, "the probe connector has its own card on the Plugins page", `${probeName} · ${probeCard.slice(0, 100)}`);
      check(connected == null || /connected/.test(probeCard), "and that card says the box connected it", probeCard.slice(0, 110));
      // -- CP-10 item 1, on a connector nothing else depends on: a throwaway value through the key
      // form, stored by the host, and no trace of it left anywhere the page can be read from.
      const secretForm = await page.$("[data-connector-secret-form]");
      if (!secretForm) console.log(`  INFO  no key form on the ${PROBE_CONNECTOR} card; the host lists no secret field and connectors.json declared none`);
      else {
        probeSecretStored = true;
        const probeValue = `PROBE-SECRET-${Math.random().toString(36).slice(2, 12)}`;
        await page.fill(`[data-connector-secret-form] input[name="PROBE_TOKEN"]`, probeValue);
        await page.click("[data-connector-secret-form] button[type=submit]"); await page.waitForTimeout(4000);
        const stored = await gw("listConnectorSecretFields", { server: PROBE_CONNECTOR }).catch(() => null);
        check((stored?.fields ?? []).includes("PROBE_TOKEN"), "the key form stored the value on the host", JSON.stringify(stored ?? null).slice(0, 120));
        const afterSubmit = await page.evaluate(() => document.documentElement.outerHTML + " " + Array.from(document.querySelectorAll("input")).map((i) => i.value).join(" "));
        check(!afterSubmit.includes(probeValue), `and left no trace of it in the DOM or in any input (${probeValue.length} chars)`);
        const storage = await page.evaluate(() => JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage));
        check(!storage.includes(probeValue), "and nothing of it reaches browser storage");
        // The 0600 file the form must never write to: the value belongs in the host's own store.
        const file = await relay("/connectors").catch(() => null);
        check(!JSON.stringify(file ?? {}).includes(probeValue), "and connectors.json still holds no value for it");
        // Taken back out BEFORE the connector is removed: deleteConnectorSecret resolves the
        // server through connectors.json, so once the row is gone the store cannot be reached and
        // the value would sit in it for the life of the box.
        const removed = await gw("deleteConnectorSecret", { server: PROBE_CONNECTOR, field: "PROBE_TOKEN" }).catch(() => null);
        const left = await gw("listConnectorSecretFields", { server: PROBE_CONNECTOR }).catch(() => null);
        // CONNECT-4: the NAME stays on the list -- connectors.json still declares PROBE_TOKEN with
        // an empty value, so the card must keep offering it. What has to be gone is the stored
        // value, and a second delete reporting removed:false is what says the store holds none.
        const again = await gw("deleteConnectorSecret", { server: PROBE_CONNECTOR, field: "PROBE_TOKEN" }).catch(() => null);
        check(removed?.removed === true && again?.removed === false && (left?.fields ?? []).includes("PROBE_TOKEN"),
          "and the gate takes its throwaway value back out of the host's store", JSON.stringify(left ?? removed ?? null).slice(0, 120));
        if (removed?.removed === true) probeSecretStored = false;
      }
      // And the removal, through the same editor -- which is on the list view, not on the plugin
      // page the checks above opened.
      await page.click("[data-marketplace-back]").catch(() => {});
      await page.waitForTimeout(800);
      await page.evaluate(() => document.querySelector("[data-connector-editor]")?.setAttribute("open", "open"));
      await page.click(`[data-connector-editor] [data-remove-connector="${PROBE_CONNECTOR}"]`).catch(async () => {
        await page.click(`.plugin-detail [data-remove-connector="${PROBE_CONNECTOR}"]`);
      });
      await page.waitForTimeout(6000);
      const afterRemove = await relay("/connectors").catch(() => null);
      check(afterRemove?.mcpServers?.[PROBE_CONNECTOR] == null, "and Remove takes it back out of connectors.json", Object.keys(afterRemove?.mcpServers ?? {}).join(", "));
      if (afterRemove?.mcpServers?.[PROBE_CONNECTOR] == null) probeConnectorAdded = false;
    }

    // -- MARKET-1: the other half of Add. A shell-tool row's `install` is a shell-tool id, not a
    // {command,args,env} entry, so its Add has to reach installShellTool and open the same plugin
    // page -- not fall through to the MCP connector editor, which is the catalog's door for a
    // custom server and writes nothing. The installer itself is never run from here
    // (shell-tool-catalog.ts: "Run inside the box as user box. Never run by the gate." -- it is a
    // curl|sh on a shared box), so installShellTool is recorded and stubbed on the adapter the
    // page already exposes for the Bots tab, and what is asserted is the route the click took.
    const shellRow = catalogPlugins.find((plugin) => String(plugin.kind) === "shell-tool") ?? null;
    if (shellRow) await openMarketplace();
    // A featured row is drawn twice on purpose (once under Featured, once under its own category),
    // so this counts buttons rather than expecting one, and clicks the first of them.
    const shellAddable = shellRow ? (await page.$$(`[data-marketplace-add="${shellRow.id}"]`)).length > 0 : false;
    if (!shellRow || !shellAddable) {
      console.log(`  INFO  ${shellRow ? `${shellRow.id} is already installed in this box, so its Add button is not on the page` : "this host's catalog has no shell-tool row"}; the shell-tool Add route is pinned by tests/machine-room-marketplace.test.mjs`);
    } else {
      const stubbed = await page.evaluate(() => {
        const held = window.__machineRoomAdapter;
        if (!held || typeof held.installShellTool !== "function") return false;
        window.__gateShellInstalls = [];
        window.__gateRealInstallShellTool = held.installShellTool;
        held.installShellTool = (id) => { window.__gateShellInstalls.push(String(id)); return Promise.resolve({ accepted: true, message: "recorded by the gate" }); };
        return true;
      });
      const shellBefore = JSON.stringify((await relay("/connectors").catch(() => null))?.mcpServers ?? null);
      await page.click(`[data-marketplace-add="${shellRow.id}"]`, { timeout: 12_000 });
      await page.waitForTimeout(2000);
      const shellPage = await page.evaluate(() => document.querySelector("[data-marketplace-account]")?.dataset.marketplaceAccount ?? null);
      const editorsOpen = (await page.$$("[data-connector-editor][open]")).length;
      const recorded = await page.evaluate(() => window.__gateShellInstalls ?? []);
      check(stubbed && shellPage === String(shellRow.id) && editorsOpen === 0,
        `Add on the ${shellRow.name} shell tool opens its own plugin page, not the connector editor`,
        `page ${shellPage}, ${editorsOpen} editor(s) open${stubbed ? "" : ", installShellTool not stubbable"}`);
      check(recorded.length === 1 && recorded[0] === String(shellRow.install ?? shellRow.id),
        "and routes through installShellTool with the catalog's shell-tool id", recorded.join(", ") || "no installShellTool call");
      const shellAfter = JSON.stringify((await relay("/connectors").catch(() => null))?.mcpServers ?? null);
      check(shellAfter === shellBefore, "and writes nothing to connectors.json for it", `${shellBefore.length} vs ${shellAfter.length} chars`);
      await page.evaluate(() => {
        const held = window.__machineRoomAdapter;
        if (held && window.__gateRealInstallShellTool) held.installShellTool = window.__gateRealInstallShellTool;
        delete window.__gateRealInstallShellTool; delete window.__gateShellInstalls;
      });
    }

    // -- MARKET-1: Add and Uninstall, on the one catalog row this gate may safely write. The
    // entry is the preset's, with the env name and NO value, so nothing authenticates and nothing
    // of the operator's is touched; connectors.json is compared byte for byte before and after.
    // Skipped rather than forced if the box already has that entry: replacing an operator's
    // tinyfish and then deleting it would leave the box worse than the gate found it.
    const addRow = catalogPlugins.find((plugin) => String(plugin.id) === "tinyfish") ?? null;
    const filesBefore = await relay("/connectors").catch(() => null);
    if (!addRow) {
      console.log("  INFO  this host's catalog has no tinyfish row, so the Add/Uninstall round trip is not exercised");
    } else if (filesBefore?.mcpServers?.tinyfish != null) {
      console.log("  INFO  this box already has a tinyfish connector; Add would replace an operator's entry, so the round trip is not exercised");
      await openMarketplace();
      const added = await page.evaluate(() => document.querySelector('[data-marketplace-added="tinyfish"]')?.textContent?.trim() ?? "");
      check(/Added/.test(added), "and the catalog card for it says Added rather than offering Add again", added);
    } else {
      const bytesBefore = JSON.stringify(filesBefore?.mcpServers ?? null);
      await openMarketplace();
      await page.click('[data-marketplace-add="tinyfish"]', { timeout: 12_000 });
      tinyfishAdded = true;
      await page.waitForTimeout(8000);
      const written = await relay("/connectors").catch(() => null);
      const spec = written?.mcpServers?.tinyfish ?? null;
      check(spec?.command === String(addRow.install?.command ?? ""), "Add on the TinyFish card writes the catalog's own entry into connectors.json", JSON.stringify(spec ?? null).slice(0, 140));
      check(spec != null && Object.values(spec.env ?? {}).every((v) => v === ""), "with the environment value named and nothing written into that 0600 file", JSON.stringify(spec?.env ?? null));
      check(Object.keys(filesBefore?.mcpServers ?? {}).every((name) => written?.mcpServers?.[name]), "and the connectors already on the box survived the write");
      // ...and lands on that plugin's page, which is where the credential goes. The page opens on
      // the click, not on the connect: a remote connector with no key yet burns the host's whole
      // 60s MCP connect timeout before its card can say anything, and the credential card is what
      // the operator needs in front of them meanwhile.
      const opened = await until(() => page.evaluate(() => document.querySelector("[data-marketplace-account]")?.dataset.marketplaceAccount ?? null), 20_000, 1000);
      check(opened === "tinyfish", "and opens the TinyFish plugin page", `account row for ${opened}`);
      // Needs auth is the state AFTER the host has finished failing to connect it, so this poll
      // has to outlast that 60s timeout; it settles as soon as the card lands, not on the cap.
      const accountRow = await until(async () => {
        const row = await page.evaluate(() => document.querySelector("[data-marketplace-account]")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
        return /Needs auth/.test(row) ? row : null;
      }, 100_000, 2500) ?? await page.evaluate(() => document.querySelector("[data-marketplace-account]")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
      check(/Needs auth/.test(accountRow), "whose Accounts row says Needs auth", accountRow.slice(0, 140));
      check((await page.$$("[data-connector-secret-form] input[type=password]")).length > 0, "and offers the credential card to answer it with");
      // Uninstall. Nothing was stored for it, so the clear offer is not drawn and the entry alone
      // comes out; the file has to come back byte-identical to the one the gate found.
      await page.click('[data-marketplace-uninstall="tinyfish"]', { timeout: 12_000 });
      await page.waitForTimeout(500);
      const armedLabel = await page.evaluate(() => document.querySelector('[data-marketplace-uninstall="tinyfish"]')?.textContent?.trim() ?? "");
      check(/Click again/.test(armedLabel), "Uninstall arms on the first click instead of removing", armedLabel);
      const stillThere = await relay("/connectors").catch(() => null);
      check(stillThere?.mcpServers?.tinyfish != null, "and the entry is untouched after that click");
      await page.click('[data-marketplace-uninstall="tinyfish"]', { timeout: 12_000 });
      await page.waitForTimeout(7000);
      const after = await relay("/connectors").catch(() => null);
      check(after?.mcpServers?.tinyfish == null, "the second click takes it back out of connectors.json", Object.keys(after?.mcpServers ?? {}).join(", "));
      check(JSON.stringify(after?.mcpServers ?? null) === bytesBefore, "and connectors.json is byte-identical to before the Add", `${bytesBefore.length} vs ${JSON.stringify(after?.mcpServers ?? null).length} chars`);
      if (after?.mcpServers?.tinyfish == null) tinyfishAdded = false;
    }

    // -- BOTS-1: the Marketplace's Bots tab, the bot page and Import Bot. The catalog is data in
    // the host bundle served by listMarketplace, and this page reads it only through the gateway,
    // so what the tab lists is what the agents' own SearchPlugins sees. Import Bot is a real write
    // on a shared box -- a new agent, and its skills in the box-wide workflow library -- so the
    // agent is deleted here as soon as it has been read back, and again in the finally if a later
    // assertion threw first.
    const marketCatalog = await gw("listMarketplace", {}).catch((error) => ({ error: error.message }));
    const marketBots = Array.isArray(marketCatalog?.bots) ? marketCatalog.bots : [];
    check(marketBots.length === 6, "listMarketplace serves the six bot templates",
      marketCatalog?.error ?? `${marketBots.length}: ${marketBots.map((b) => b.name).join(", ")}`);
    const researchDesk = marketBots.find((b) => String(b?.name ?? "") === "Research desk") ?? null;
    if (marketBots.length === 0) {
      console.log("  INFO  this host serves no bot catalog; the Bots-tab checks below are skipped");
    } else {
      await openMarketplace();
      const opened = await page.click("#panel-dialog [data-marketplace-tab='bots']", { timeout: 4000 }).then(() => true).catch(() => false)
        || await page.locator("#panel-dialog button", { hasText: /^Bots$/ }).first().click({ timeout: 4000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(2000);
      const listed = await page.$$eval("[data-marketplace-bots] [data-bot-id]", (els) => [...new Set(els.map((e) => e.dataset.botId))]).catch(() => []);
      check(listed.length === marketBots.length, "the Bots tab lists every template the catalog serves",
        `${listed.length} on screen of ${marketBots.length} in the catalog${opened ? "" : " (no Bots tab to click)"}`);
      if (researchDesk == null) check(false, "the catalog carries the Research desk template", marketBots.map((b) => b.name).join(", "));
      else if (listed.includes(String(researchDesk.id))) {
        await page.click(`[data-bot-id="${researchDesk.id}"]`); await page.waitForTimeout(1000);
        const tabs = await page.$$eval("[data-bot-tab]", (els) => els.map((e) => e.dataset.botTab));
        check(["instructions", "skills", "integrations"].every((t) => tabs.includes(t)), "the bot page carries its three left tabs", tabs.join(", "));
        check((await page.$$(`[data-import-bot="${researchDesk.id}"]`)).length === 1, "and one Import Bot button");
        // Tools it can use: one row per integration the template names, each either already
        // installed or carrying the Add that goes through the Plugins tab's own install path.
        await page.click(`[data-bot-tab="integrations"]`).catch(() => {}); await page.waitForTimeout(800);
        const integrationRows = await page.$$eval("[data-integration]", (els) => els.map((e) => ({
          id: e.dataset.integration,
          add: e.querySelector("[data-add-integration]") != null,
          installed: /installed/i.test(e.textContent ?? ""),
        })));
        const wantedIntegrations = (researchDesk.integrations ?? []).map(String);
        check(integrationRows.length === wantedIntegrations.length && wantedIntegrations.every((id) => integrationRows.some((r) => r.id === id)),
          "the Integrations tab lists every plugin the template needs", `${integrationRows.map((r) => r.id).join(", ")} vs ${wantedIntegrations.join(", ")}`);
        check(integrationRows.every((r) => r.add || r.installed), "and every one of them is either installed or offers Add",
          integrationRows.map((r) => `${r.id}:${r.installed ? "installed" : r.add ? "add" : "neither"}`).join(", "));

        // The import itself. The workflow library is box-wide, so what it adds is snapshotted
        // before the click and swept in the finally.
        const anyAgentId = (((await gw("listAgents").catch(() => [])) ?? [])[0] ?? {}).id ?? null;
        botLibraryBefore = anyAgentId ? await libraryIds(anyAgentId).catch(() => null) : null;
        const idsBefore = new Set(((await gw("listAgents").catch(() => [])) ?? []).map((a) => a.id));
        await page.click(`[data-import-bot="${researchDesk.id}"]`);
        const importedId = await until(async () => (((await gw("listAgents").catch(() => null)) ?? []).find((a) => !idsBefore.has(a.id)) ?? {}).id ?? null, 60_000, 2000);
        check(importedId != null, "Import Bot creates the agent on the host", importedId ?? "no new agent after 60s");
        if (importedId != null) {
          botAgentId = importedId;
          const row = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === importedId) ?? {};
          // This host stores an agent as { name, description, title } and feeds the model only
          // name + description as its identity, so the template's description and its
          // instructions share that one field, description first (docs/MARKETPLACE.md).
          const wantedDescription = `${String(researchDesk.description ?? "").trim()}\n\n${String(researchDesk.instructions ?? "").trim()}`.trim();
          check(String(row.description ?? "").trim() === wantedDescription,
            "and its description is the template's description followed by its instructions",
            `${String(row.description ?? "").slice(0, 90)}…`);
          const held = (((await gw("getAgentWorkflows", { id: importedId }).catch(() => [])) ?? []).filter((w) => w.source !== "automation")).map((w) => w.name);
          const wantedSkills = (researchDesk.skills ?? []).map((s) => String(s?.name ?? ""));
          check(wantedSkills.length > 0 && wantedSkills.every((name) => held.includes(name)),
            "and its skills are the template's skills, read back from the host", `${held.join(", ")} vs ${wantedSkills.join(", ")}`);
          const shown = await until(() => page.evaluate(() => document.querySelector("[data-imported-agent]")?.textContent?.replace(/\s+/g, " ") ?? null), 20_000, 1000);
          check(shown != null && shown.includes(String(row.name ?? "")), "and the bot page shows the agent it just imported", (shown ?? "no imported card on screen").slice(0, 140));
          // Deleted here rather than only in the finally: this is a shared box and every later
          // check in this run would otherwise see a template agent in the roster.
          await gw("deleteAgent", { id: importedId }).catch(() => {});
          const gone = await until(async () => ((((await gw("listAgents").catch(() => null)) ?? []).some((a) => a.id === importedId)) ? null : true), 20_000, 1000);
          check(gone === true, "and the gate deletes the agent it imported");
          if (gone === true) botAgentId = null;
        }
      } else check(false, "the Bots tab draws a card for Research desk", listed.join(", "));
      await openMarketplace();
    }

    // -- PROVIDERS-1: the providers and the chat listeners the Marketplace no longer carries are
    // sections in Settings, built from the same cards. Everything below this line used to run on
    // the Plugins page; only the panel it is read from changed.
    await openSettingsPanel();
    const settingsHeadings = await page.$$eval(".settings-list h3", (els) => els.map((e) => e.textContent.trim()));
    check(settingsHeadings.indexOf("Providers") === settingsHeadings.indexOf("Inference") + 1 && settingsHeadings.includes("Inference"),
      "Settings carries a Providers section directly under Inference", settingsHeadings.join(" | "));
    check(settingsHeadings.includes("Chat listeners"), "and the chat listeners are a Settings section too", settingsHeadings.join(" | "));
    const relaySubs = await relay("/subscriptions").then((r) => (Array.isArray(r) ? r : r?.subscriptions ?? [])).catch(() => []);
    const providerIds = await page.$$eval('[data-plugin-group="Providers"] [data-plugin-id]', (els) => els.map((e) => e.dataset.pluginId));
    check(relaySubs.length > 0 && providerIds.length === relaySubs.length && providerIds.every((id) => id.startsWith("sub:")),
      `and the Providers section lists every subscription the relay reports (${relaySubs.length})`, providerIds.join(", "));

    // -- GW-08 item 2: a listener card shows getAgentChannels for the agent on screen.
    const onScreen = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
    const onScreenId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === onScreen)?.id ?? null;
    const channels = onScreenId ? await gw("getAgentChannels", { id: onScreenId }).catch(() => null) : null;
    await pickPlugin("slack", openSettingsPanel);
    const channelRow = await page.evaluate(() => document.querySelector("[data-channel-state='slack']")?.textContent?.replace(/\s+/g, " ") ?? "");
    const slackConnected = (channels?.connections ?? []).some((c) => c.platform === "slack");
    check(channelRow.includes(onScreen) && new RegExp(slackConnected ? "connected" : "not connected").test(channelRow) && (slackConnected || !/: connected/.test(channelRow)), "the Slack listener card shows this agent's channel state from getAgentChannels", `${onScreen} → ${channelRow.slice(0, 110)}`);
    // -- CP-04: Connect on a listener opens a local token form that calls connectChannel for the
    // agent on screen. The old vendor-hosted route is gone: no second button, no vendor name.
    if (slackConnected) {
      check((await page.$$("[data-disconnect-plugin='slack']")).length === 1, "a connected Slack listener offers to disconnect for this agent");
    } else {
      const localForm = await page.$("[data-connect-channel='slack']");
      check(localForm != null, "Connect on the Slack listener opens a local token form, not cursor.com");
      check((await page.$$("[data-connect-channel='slack'] input[type=password]")).length === 1, "and the token field is masked");
      const detailText = await page.evaluate(() => document.querySelector(".plugin-detail")?.textContent ?? "");
      check((await page.$$("[data-install-plugin='slack']")).length === 0 && !/cursor/i.test(detailText), "with no second route and no vendor name on the card", detailText.slice(0, 120));
      // Not submitted: connectChannel with a made-up token would bind a real listener on a shared
      // box. tests/machine-room-connectors.test.mjs pins the argument names against a stub.
    }

    // -- MR-04: a provider whose route this host cannot adopt offers no Connect button.
    await pickPlugin("sub:claude", openSettingsPanel);
    const connectButtons = await page.$$("[data-install-plugin]");
    const connectNote = await page.evaluate(() => document.querySelector(".plugin-detail .secure-card-header small")?.textContent?.trim() ?? "");
    check(connectButtons.length === 0, "a non-adoptable provider card shows no Connect button", `${connectButtons.length} button(s)`);
    check(/Not adoptable|not usable/i.test(connectNote), "and says why instead", connectNote.slice(0, 100));
    // The same rule on the other shape of un-adoptable card: route "endpoint" is not enough, the
    // provider's own CLI has to hold a usable login for the relay to copy. MiniMax has none here,
    // and getListenerConnectUrl{platform:"sub:minimax"} does NOT error -- it answers with an
    // unrelated Cursor URL -- so a button here would open a tab and toast a success that is false.
    const minimax = await relay("/subscriptions").then((r) => (Array.isArray(r) ? r : r?.subscriptions ?? []).find((s) => s.id === "minimax")).catch(() => null);
    if (minimax && minimax.usable !== true && minimax.adopted !== true) {
      await pickPlugin("sub:minimax", openSettingsPanel);
      const mmButtons = await page.$$("[data-install-plugin]");
      const mmNote = await page.evaluate(() => document.querySelector(".plugin-detail .secure-card-header small")?.textContent?.trim() ?? "");
      check(mmButtons.length === 0, "a CLI-login provider with no login on this Mac shows no Connect button", `${mmButtons.length} button(s)`);
      check(/Nothing to adopt yet/i.test(mmNote), "and says the CLI holds no login instead", mmNote.slice(0, 110));
    } else {
      check(true, "MiniMax is adoptable on this Mac, so the un-adoptable endpoint card is not exercised", `usable ${minimax?.usable}, adopted ${minimax?.adopted}`);
    }
    // -- MR-03: the key form on a card that is definitely NOT adopted, so the hint really renders.
    await pickPlugin("sub:gemini-key", openSettingsPanel);
    const keyHint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
    check(/0600 store/.test(keyHint) && !/discard/i.test(keyHint), "the key form says where the value goes, not that it is discarded", keyHint.slice(0, 120));
    await noDemoStrings("providers in Settings");

    // -- The Providers switch still moves the box (docs/DASHBOARD-CONTRACT.md).
    await pickPlugin("sub:zai", openSettingsPanel);
    // Scoped to the card under test. These three were document-wide, and the Settings panel renders
    // the Providers group, the Listeners group and the Job bus section into ONE .settings-list, so
    // any password input anywhere on the panel -- the job bus bearer, a connector's secret field --
    // read as "the Z.AI card offers a key field" and sent the run into the hint check below against
    // a card that has no key form. That is what made this leg fail on a bus the leg is not about.
    const hasKeyField = (await page.$$(".plugin-detail input[type=password]")).length > 0;
    const hasSwitch = (await page.$$(".plugin-detail [data-use-endpoint]")).length > 0;
    const isLive = (await page.$$eval(".plugin-detail .provider-switch .status-pill", (els) => els.map((e) => e.textContent.trim()))).includes("answering now");
    check(hasKeyField || hasSwitch || isLive, "the Z.AI card offers a key field, a switch, or shows it is answering", `key ${hasKeyField}, switch ${hasSwitch}, live ${isLive}`);
    if (hasKeyField) {
      const hint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
      check(/0600 store/.test(hint), "the key form says where the value goes", hint.slice(0, 110));
    }
    if (hasSwitch) {
      await page.click(".plugin-detail [data-use-endpoint]"); await page.waitForTimeout(2500);
      const live = await relay("/model");
      check(/z\.ai/.test(String(live?.endpoint ?? "") + String(live?.baseUrl ?? "")) || /glm/.test(String(live?.model ?? "")), "the switch moved the box to Z.AI", `${live?.model} · ${live?.endpoint ?? live?.baseUrl ?? ""}`);
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);

    // -- The Files view is real, and labelled as what it is.
    apiCalls.length = 0;
    // CHAT-LONG-1 / DASH-GW03: by id, and the selection is asserted. See selectAgentByName above
    // for what a text match cost this arc.
    const ateraSelectedId = await selectAgentByName("Atera Triage");
    await page.waitForTimeout(2500);
    // Loading a conversation here is two serial round trips -- getAgentTranscriptTail beside four
    // other reads, then getConversationOutline for the tool rows woven into it -- and the checks
    // below are about what those produced, not how fast they arrived. A fixed 2.5s made them a
    // latency measurement of everything that ran earlier in this file, and this wave's Marketplace
    // and Bots arcs (a connector Add whose unkeyed server burns the host's own 60s MCP connect,
    // an agent created, four workflows imported into it and the agent deleted) pushed a long
    // conversation past it: 0 rows on the page that renders 213 as soon as the answer lands.
    // Wait for the transcript to be on screen, with a cap, then assert what it says.
    await until(async () => ((await page.$$(".message-row")).length > 0 ? true : null), 30_000, 1000);
    // -- GW-03(b): the conversation is a tail window. Nothing on this page asks for the whole
    // transcript, the outline's tool rows still weave into the tail, the evidence chips ride on
    // the row above it pages older entries in through getAgentTranscriptPage.
    check(callsTo("getAgentTranscript") === 0 && callsTo("getAgentTranscriptTail") > 0, "selecting an agent reads getAgentTranscriptTail, never getAgentTranscript", `${callsTo("getAgentTranscriptTail")} tail, ${callsTo("getAgentTranscript")} whole`);
    // A tool row is one the adapter gave a `tool-` id. It used to be recognised by the words it
    // started with, which SHOT-4's plain-word headlines ("Wrote notes.md", "Opened example.com")
    // legitimately no longer begin with.
    const toolRowsInTail = await page.$$eval('.message-row.is-system[data-message-id^="tool-"]', (els) => els.length);
    check(toolRowsInTail > 0, "outline tool rows are woven into the tail-loaded transcript", `${toolRowsInTail} row(s)`);
    check((await page.$$(".evidence-chip")).length > 0, "evidence chips render on tail-loaded entries");
    const rowsBefore = (await page.$$(".message-row")).length;
    const olderButton = await page.$("[data-load-older]");
    check(olderButton != null, "a long conversation offers to show earlier messages", `${rowsBefore} rows on screen`);
    if (olderButton) {
      await olderButton.click();
      const grew = await until(async () => ((await page.$$(".message-row")).length > rowsBefore ? (await page.$$(".message-row")).length : null), 10_000, 500);
      check(grew != null && callsTo("getAgentTranscriptPage") >= 1, "and one click pages older entries in through getAgentTranscriptPage", `${rowsBefore} → ${grew ?? rowsBefore} rows, ${callsTo("getAgentTranscriptPage")} page call(s)`);
    }
    // MR-05 again, on an agent the box has already given a screen: the row resolves to the fact,
    // not just to the sentence that says it is asking.
    await page.click("#room-menu"); await page.waitForTimeout(1200);
    const screenRow = (await settled("[data-browser-screen]", /^Asking the host/)) ?? "";
    check(/display :\d+|shared screen/.test(screenRow), "the Browser row resolves to this agent's real screen", screenRow.slice(0, 90) || "still 'Asking the host…' after 25s");
    // -- AUDIT-1 UI half: the Action ledger disclosure on an agent with tool history, against
    // getAgentActionAudit's own answer; tool output stays out of the DOM until one row is asked for.
    const ledgerAgentId = ateraSelectedId;
    const hostLedger = ledgerAgentId ? await gw("getAgentActionAudit", { id: ledgerAgentId, limit: 25 }).catch(() => null) : null;
    await page.click("[data-read-audit]");
    const ledgerRows = await until(() => page.evaluate(() => { const l = document.querySelector("[data-audit-list]"); return l && l.textContent.trim() ? l.querySelectorAll("[data-audit-row]").length : null; }), 10_000, 500);
    check(hostLedger != null && ledgerRows === hostLedger.rows.length, "AUDIT-1: the Action ledger disclosure lists getAgentActionAudit's rows for this agent", `${ledgerRows ?? "none"} on the panel, ${hostLedger?.rows?.length ?? "?"} on the host`);
    const ledgerHeads = await page.$$eval("[data-audit-head-slot]", (els) => els.map((e) => e.textContent.trim()));
    check(ledgerHeads.length === (ledgerRows ?? 0) && ledgerHeads.every((h) => /not on this page until you ask/i.test(h)), "and every row's tool output is withheld until asked for", `${ledgerHeads.length} slot(s)`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    const filesTab = await page.evaluate(() => document.querySelector("[data-desktop-app='files'] small")?.textContent?.trim() ?? "");
    check(filesTab === "Files from this conversation", "the Files tab is labelled for what it renders", filesTab);
    check((await page.$$("[data-desktop-app='sheets']")).length === 0, "the placeholder Sheets tab is gone");
    await page.click("#rail-screen .rail-screen-button"); await page.waitForTimeout(1200);
    // -- MR-11: the "Current run" rail. It used to be one synthetic line ("Started — no step
    // detail from this host") whatever the agent was doing. It is now this turn's tool rows, the
    // same rows the adapter wove into the transcript from the conversation outline.
    // The assertion is an EXACT match against the rule read off the rendered transcript: the tool
    // rows after the last thing the operator sent, last twelve, in order. An earlier version of
    // this check only asked that the rail carried no row the transcript lacked, which an idle
    // agent satisfies with zero rows -- and zero rows is exactly what the PRE-change code drew
    // ("Nothing running for this worker" is byte-identical in both), so it proved nothing. So the
    // rail is asserted on an agent whose transcript actually carries tool rows for this turn: the
    // roster is walked until one is found, and the agent that was on screen is put back.
    const railRowsNow = () => page.$$eval("#desktop-timeline li", (els) => els.map((e) => e.textContent.trim()));
    // The MR-11 rule, evaluated over the DOM rather than over the adapter's arrays, so the
    // expectation is computed from the host's own rendered transcript and not from app.js.
    const railExpectation = () => page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".message-row"));
      let lastFromYou = -1;
      rows.forEach((el, i) => { if (el.classList.contains("is-user")) lastFromYou = i; });
      return rows.slice(lastFromYou + 1)
        .filter((el) => el.classList.contains("is-system") && String(el.dataset.messageId ?? "").startsWith("tool-"))
        // SHOT-4 changed a summarised tool row from a <div> holding one line into a <details>
        // whose <summary> is that line and whose <pre> is the verbatim command and output. The
        // row's TEXT is the summary; textContent on the whole row now returns the headline with
        // the receipt concatenated onto it, which is not what the rail draws and never was.
        .map((el) => (el.querySelector(".tool-receipt > summary") ?? el).textContent.trim())
        .slice(-12);
    });
    const railOnScreenId = await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null);
    let railRows = await railRowsNow();
    let expectedRail = await railExpectation();
    let railAgent = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
    // Escape does not reliably close the desktop dialog here, and a roster click that lands on a
    // dialog backdrop selects nothing: every navigation in this block closes the open dialogs
    // itself and then waits for the room title to be the agent it asked for.
    const openRoom = async (id, name) => {
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
      await page.waitForTimeout(400);
      await page.click(`.worker-card[data-context-id="${id}"]`, { timeout: 10_000 }).catch(() => {});
      const arrived = await until(() => page.evaluate((n) => (document.getElementById("room-title")?.textContent === n ? true : null), name), 20_000, 700);
      await page.waitForTimeout(1500);
      await page.click("#rail-screen .rail-screen-button", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      return arrived === true;
    };
    if (expectedRail.length === 0) {
      // Nothing to discriminate on this agent. Try the others, then come back.
      const roster = await page.$$eval(".worker-card[data-context-id]", (els) => els.map((e) => ({ id: e.dataset.contextId, name: e.querySelector(".worker-name")?.textContent?.trim() ?? "" })));
      for (const worker of roster) {
        if (worker.id === railOnScreenId) continue;
        if (!(await openRoom(worker.id, worker.name))) continue;
        expectedRail = (await until(async () => { const rows = await railExpectation(); return rows.length ? rows : null; }, 10_000, 1500)) ?? [];
        if (expectedRail.length > 0) {
          railRows = await railRowsNow();
          railAgent = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
          break;
        }
      }
    }
    check(!railRows.some((row) => /no step detail from this host/.test(row)),
      "the Current run rail is not the old synthetic step", railRows.slice(0, 2).join(" | ").slice(0, 140));
    if (expectedRail.length > 0) {
      const same = railRows.length === expectedRail.length && railRows.every((row, i) => row === expectedRail[i]);
      check(same, `the Current run rail is exactly this turn's tool rows from the transcript, in order (${expectedRail.length} row(s) on ${railAgent})`,
        same ? expectedRail[0].slice(0, 110) : `rail ${JSON.stringify(railRows).slice(0, 140)} vs transcript ${JSON.stringify(expectedRail).slice(0, 140)}`);
    } else {
      // No agent on this box has a tool row after its last operator message, so the empty state is
      // the only render available and it cannot tell the two versions apart. Say so rather than
      // bank a vacuous PASS; the rule itself is pinned by tests/machine-room-connectors.test.mjs.
      console.log(`  INFO  no agent on this box has a tool row after its last operator message (rail: ${JSON.stringify(railRows).slice(0, 100)}); the MR-11 rule is pinned by tests/machine-room-connectors.test.mjs`);
      check(railRows.length === 1 && /Nothing running|no tool call for this turn/.test(railRows[0]),
        "and the rail says so instead of inventing a step", railRows.join(" | ").slice(0, 120));
    }
    // Back to the agent the rest of this section reads (the evidence chips below are Atera's).
    if (railOnScreenId && (await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null)) !== railOnScreenId) {
      const backName = await page.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"] .worker-name`)?.textContent?.trim() ?? "", railOnScreenId);
      check(await openRoom(railOnScreenId, backName), "the gate is back on the agent it walked away from", backName);
    }
    // -- GW-10(a): the hand-back control exists and is hidden while the host reports no pending
    // hand-off for this agent (getForeverBoxStatus.handoff is where pendingHandoff surfaces).
    //
    // HANDBACK-1 moved this control. It used to be a button in the desktop view's footer with its
    // note beside it; it is the "I'm done, continue" half of the takeover banner now, and the whole
    // hand-off has a card of its own in the conversation. The IDS DID NOT MOVE (#hand-back,
    // #hand-back-note), which is exactly what keeps this leg pointed at the real control instead of
    // going red for the wrong reason. Two things did have to change here, and neither weakens what
    // the leg measures:
    //   - visibility is read the way a person meets it -- the element and every ancestor, including
    //     a closed <dialog> -- rather than by reading `el.hidden` on the button alone. The banner
    //     carries the hidden state now, so reading the button's own attribute would have reported
    //     "not hidden" for a control nobody can see. That is stricter than what it replaced.
    //   - the leg asserts the desktop view is actually OPEN when it measures, so "hidden while
    //     nothing is pending" cannot pass vacuously on a closed dialog.
    const handBackView = () => page.evaluate(() => {
      const el = document.getElementById("hand-back");
      const dialog = document.getElementById("desktop-dialog");
      const dialogOpen = dialog?.open === true;
      if (!el) return { present: false, dialogOpen };
      let hidden = false;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (node.hidden === true || cs.display === "none" || cs.visibility === "hidden") { hidden = true; break; }
      }
      const rect = el.getBoundingClientRect();
      return {
        present: true, hidden, dialogOpen, disabled: el.disabled === true,
        // The banner's own button, and -- when the console stops carrying the owner on the button
        // itself -- the hand-off card's frozen data-agent-id, which names the same agent.
        owner: el.dataset.handBack ?? "",
        cardOwner: document.querySelector("[data-handoff-card] [data-handoff-action]")?.dataset.agentId ?? "",
        note: document.getElementById("hand-back-note")?.textContent ?? "",
        w: Math.round(rect.width), h: Math.round(rect.height),
      };
    });
    const ateraId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === "Atera Triage")?.id ?? null;
    const boxNow = ateraId ? await gw("getForeverBoxStatus", { id: ateraId }).catch(() => null) : null;
    const handBack = await handBackView();
    check(handBack.dialogOpen === true, "the desktop view is open where the hand-back control is measured", `#desktop-dialog open ${handBack.dialogOpen}`);
    check(handBack.present && handBack.hidden === (boxNow?.handoff == null), "the hand-back control is in the desktop view and hidden exactly while no hand-off is pending", `present ${handBack.present}, hidden ${handBack.hidden}, host handoff ${JSON.stringify(boxNow?.handoff ?? null)}`);
    // -- GW-10, the hand-back loop end to end, driven the way a user meets it. It used to force the DOM --
    // set el.hidden = false, write the agent id into the dataset by hand, call el.click() -- on an
    // agent with nothing pending, so handBackForeverBox answered null and the check proved only
    // that the click handler does not throw. It could not tell a working control from one that
    // never appears or never clears anything.
    //
    // request_box_help is the only writer of a pending hand-off (BoxHandoffService.start, reached
    // through the session extension's startHandoff); no gateway command sets one. So this costs
    // ONE model turn on the probe agent: ask it to call the tool, wait for the host to report the
    // hand-off, then let the page paint the button itself, click that button, and check the host
    // agrees the hand-off is gone. A turn that does not come back inside the budget is a SKIP, the
    // same rule the unread probe follows -- a cold provider is not a dashboard defect. Handing the
    // box back revives the agent, so the probe may spend one more turn of its own after this.
    if (probeAgentId) {
      // HANDBACK-1 again: the ask is by INTENT, not by tool name. Asked for request_box_help by
      // name, the model has answered that it does not have the tool while the host's own toolset
      // line listed it, which failed this leg for the model's manners rather than for the console.
      // The instruction is the agent's own words now, so the note check reads the host's copy of it
      // instead of a string this file made up.
      await gw("sendPrompt", {
        agentId: probeAgentId,
        prompt: "I need to sign in to something on your computer myself. Hand the computer over to "
          + "me with a one-line instruction and wait for me. Do not try to sign in yourself.",
      }).catch(() => null);
      const pending = await until(async () => {
        const status = await gw("getForeverBoxStatus", { id: probeAgentId }).catch(() => null);
        return status?.handoff ?? null;
      }, TURN_TIMEOUT_MS, 3000);
      if (pending == null) {
        check(true, `hand-back probe skipped — the probe never handed the computer over inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s turn budget (the box's endpoint, not the dashboard)`);
      } else {
        const instruction = String(pending.instruction ?? "");
        check(true, "an ordinary ask put a real pending hand-off on the host", JSON.stringify(pending).slice(0, 140));
        const errorsBefore = errors.length;
        // The probe's name is not probeName by now: the GW-01 identity checks renamed it. Ask the
        // roster what it is called, or openRoom waits out its whole budget on a title that moved.
        const roomWas = await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null);
        const probeNow = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === probeAgentId)?.name ?? probeName;
        const arrived = await openRoom(probeAgentId, probeNow);
        // openRoom already opens the ordinary desktop view. Since HANDBACK-1 the banner belongs to
        // the takeover the card's own "Take over" opens, so if the control is not on screen after
        // the ordinary open, take over the way a person does and look again. A run where neither
        // path shows it still fails on its own number below.
        let shown = await until(async () => { const v = await handBackView(); return v.present && !v.hidden ? v : null; }, 8000, 700);
        if (shown == null && (await page.$('[data-handoff-action="take-over"]')) != null) {
          await page.click('[data-handoff-action="take-over"]', { timeout: 8000 }).catch(() => {});
          shown = await until(async () => { const v = await handBackView(); return v.present && !v.hidden ? v : null; }, 15_000, 700);
        }
        const owner = shown ? (shown.owner || shown.cardOwner) : "";
        check(shown != null && owner === probeAgentId, "the hand-back control appears on its own once a hand-off is pending, aimed at the agent that asked", shown ? `owner ${owner || "(unnamed)"}, ${shown.w}x${shown.h}, room reached ${arrived}` : "still hidden after 23s");
        check(shown != null && shown.note.includes(instruction), "and the note beside it repeats the instruction the agent asked for", `${(shown?.note ?? "").slice(0, 120)} · host: ${instruction.slice(0, 60)}`);
        if (shown != null) {
          await page.click("#hand-back", { timeout: 10_000 });
          const cleared = await until(async () => {
            const status = await gw("getForeverBoxStatus", { id: probeAgentId }).catch(() => null);
            return status != null && status.handoff == null ? true : null;
          }, 20_000, 1000);
          check(cleared === true && callsTo("handBackForeverBox") >= 1, "clicking it clears the pending hand-off on the host", `${cleared === true ? "cleared" : "the host still reports it pending after 20s"}; ${callsTo("handBackForeverBox")} handBackForeverBox call(s)`);
          // Re-hiding follows the host's status event, so it lands as soon as the hand-off clears.
          // Since HANDBACK-1 the click also closes the takeover view, which hides the control the
          // same way; the ancestor walk counts a closed <dialog> as hidden, which is what a person
          // sees either way.
          const rehid = await until(async () => ((await handBackView()).hidden === true ? true : null), 15_000, 500);
          check(rehid === true && errors.length === errorsBefore, "and the control hides itself again once nothing is pending, with no page error", `${rehid === true ? "hidden" : "still visible after 15s"}; ${errors.length - errorsBefore} new page error(s)`);
          // The bug this guards is real: the handler's .finally used to read event.currentTarget,
          // null by then, which threw out of the promise chain and left the button disabled for
          // good. It used to be a TURN budget, because handBackForeverBox did not answer until the
          // agent it revived had finished a turn. HANDBACK-1 made that resume fire-and-forget, so
          // the answer is a command answer now and this should land in a second or two; the turn
          // budget stays as the ceiling and the elapsed time is printed, so a regression back to
          // the blocking shape shows up as a number rather than as a silent wait.
          const reenableAt = Date.now();
          const reenabled = await until(async () => ((await handBackView()).disabled === false ? true : null), TURN_TIMEOUT_MS, 1000);
          if (reenabled === true) check(true, "and the button re-enables once handBackForeverBox answers", `${((Date.now() - reenableAt) / 1000).toFixed(1)}s`);
          else check(true, `button re-enable skipped — handBackForeverBox has not answered inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s budget`);
        }
        // The checks below this block read Atera's conversation. Put the page back where it was,
        // or they measure the probe and report Atera's evidence chips as missing.
        if (roomWas && roomWas !== probeAgentId) {
          const backName = await page.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"] .worker-name`)?.textContent?.trim() ?? "", roomWas);
          check(await openRoom(roomWas, backName), "the gate is back on the agent the hand-back probe walked away from", backName);
        }
      }
    }
    // Handing the computer back closes the desktop view now, and the Files check below is inside
    // that view. Re-open it if this block's click closed it, or a leg about the file list would
    // fail on a dialog HANDBACK-1 shut.
    if ((await page.evaluate(() => document.getElementById("desktop-dialog")?.open !== true)) === true) {
      await page.click("#rail-screen .rail-screen-button", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    await page.click("[data-desktop-app='files']"); await page.waitForTimeout(1200);
    await noDemoStrings("files view");
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);

    // -- GW-13: an evidence chip opens the receipts behind the verdict.
    // A 500-row tail renders in batches, and a fixed 600ms after the scroll made the chip-presence
    // leg a race: on the confirming rerun it read zero chips and took the four legs below it out of
    // the run entirely. Wait for the tail to actually carry chips, then report whatever is there at
    // the cap, so a genuinely chip-less conversation still fails with its own number.
    for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000);
    await until(async () => (await page.$$(".evidence-chip")).length > 0 || null, 20_000, 1000);
    const chips = await page.$$(".evidence-chip");
    check(chips.length > 0, "evidence chips render on Atera's stamped replies", `${chips.length} chip(s)`);
    if (chips.length === 0) {
      notReached("no evidence chip on the tail to open",
        "the chip opens a disclosure with the receipt and attestation counts",
        "the disclosure names at least one tool",
        "attested tool output is withheld until asked for",
        "and one click reveals that one attestation's output");
    }
    if (chips.length > 0) {
      // The verdict word is on the chip's data-verdict, not in its sentence: the copy says what
      // the reader gets out of it, not which of five internal words the host picked.
      const evidenced = await page.evaluateHandle(() => document.querySelector('.evidence-chip[data-verdict="evidenced"]') ?? null);
      const target = evidenced.asElement() ?? chips.at(-1);
      await target.scrollIntoViewIfNeeded();
      await target.click(); await page.waitForTimeout(1200);
      // The disclosure opens empty and fills from getEvidence. Until that answers, its body reads
      // "Reading the receipts from the host…" -- which already carries the word "receipt", so a
      // fixed wait that ran out early half-satisfied the check below while naming no tool and
      // holding no attestation. Wait for the answer instead, and report whatever is there at the
      // cap so a genuinely empty disclosure still fails with its own words.
      const readReceipts = async () => page.evaluate(() => document.getElementById("panel-dialog")?.textContent?.replace(/\s+/g, " ") ?? "");
      const text = await until(async () => {
        const seen = await readReceipts();
        return seen && !/Reading the receipts from the host/.test(seen) ? seen : null;
      }, 30_000, 1000) ?? await readReceipts();
      check(/receipt/.test(text) && /attestation/.test(text), "the chip opens a disclosure with the receipt and attestation counts", text.slice(0, 130));
      check(/tool · \S/.test(text), "the disclosure names at least one tool", (/tool · [^ ]+/.exec(text) ?? ["none"])[0]);
      // An attested head is the raw tool result the host keeps out of model context. It is not in
      // the DOM until one attestation is asked for, and the reveal is per-attestation.
      const heads = await page.$$eval("[data-head-slot]", (els) => els.map((e) => e.textContent.trim()));
      const reveal = await page.$$("[data-reveal-head]");
      check(heads.length === 0 || heads.every((h) => /not on this page until you ask/i.test(h)), "attested tool output is withheld until asked for", `${heads.length} slot(s), ${reveal.length} reveal button(s)`);
      if (reveal.length === 0) notReached("the disclosure offered no per-attestation reveal button", "and one click reveals that one attestation's output");
      if (reveal.length > 0) {
        await reveal[0].click(); await page.waitForTimeout(600);
        const shown = await page.evaluate(() => document.querySelector("[data-head-slot='0']")?.textContent?.trim() ?? "");
        check(shown.length > 0 && !/not on this page until you ask/i.test(shown), "and one click reveals that one attestation's output", shown.slice(0, 70));
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    }

    // -- The routines panel, and the trigger editor's honesty about event triggers. The picker
    // offered seven kinds; six of them are event triggers and this host can serve none of them.
    // It builds exactly two event sources (createBackendRelaySources: Slack and GitHub), hands the
    // trigger hub those two and nothing else, and both were polled out of a relay this product no longer has,
    // which needs a login this box does not have. A routine saved on one took the form, showed the
    // word "trigger" where its countdown goes, and never fired. The read-only checks come first;
    // the AUTOMATION-3 check below is the only one that writes, and it removes what it planted.
    await page.click("#schedule-button"); await page.waitForTimeout(1500);
    const routinesTitle = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
    const routinesFor = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === routinesTitle)?.id ?? null;
    const cardNames = await page.$$eval(".routine-card h3", (els) => els.map((e) => e.textContent.trim()));
    const hostRoutines = routinesFor == null ? [] : ((await gw("getAgentAutomations", { id: routinesFor }).catch(() => [])) ?? []);
    check(routinesFor != null && cardNames.length === hostRoutines.length && hostRoutines.every((r) => cardNames.includes(r.name)),
      "the routines panel lists exactly the routines the host reports for this agent",
      `page ${JSON.stringify(cardNames)} vs host ${JSON.stringify(hostRoutines.map((r) => r.name))}`);
    await page.click(".routine-create > summary").catch(() => {}); await page.waitForTimeout(800);
    const triggerNote = await page.evaluate(() => document.querySelector("[data-event-triggers-note]")?.textContent?.replace(/\s+/g, " ") ?? "");
    const integrations = await gw("getListenerIntegrations").catch(() => null);
    // Same id and same case the page derives (gateway-adapter pluginsOf), so a host that answered
    // "Slack" rather than "slack" cannot make a correctly offered kind look misoffered here.
    const connectedListeners = new Set((integrations?.integrations ?? integrations ?? []).filter((p) => p.isConnected ?? p.connected)
      .map((p) => String(p.id ?? p.platform ?? p.name ?? "").toLowerCase()));
    check(/need a listener this box has not connected/.test(triggerNote) && /not wired into this workspace yet/.test(triggerNote) && !/cursor/i.test(triggerNote),
      "the trigger editor says event triggers need a listener this box does not have, and names why", triggerNote.slice(0, 200));
    const kindOptions = await page.$$eval("#trigger-stack select[data-trig-field='type'] option", (els) => els.map((e) => ({ value: e.value, disabled: e.disabled, label: e.textContent.trim() })));
    const misoffered = kindOptions.filter((o) => (o.value === "cron" || connectedListeners.has(o.value) ? o.disabled : !o.disabled));
    check(kindOptions.length > 1 && misoffered.length === 0,
      "a schedule and every connected listener stay selectable; the kinds this box cannot serve do not",
      `${kindOptions.length} kind(s), ${connectedListeners.size} connected listener(s), wrong: ${JSON.stringify(misoffered)}`);
    check(kindOptions.filter((o) => o.disabled).every((o) => /no listener on this box/.test(o.label)),
      "and a kind that cannot be chosen says so in its own label", JSON.stringify(kindOptions.filter((o) => o.disabled).map((o) => o.label)));

    // -- AUTOMATION-3: a scheduled run that fails raises no tray error, on purpose (automation-
    // runtime.ts runLocalScheduledAutomation reports a background failure through the run record
    // rather than an alert about a run the operator did not start). So this card is the ONLY place
    // the failure can be seen, and it was not on it: the host's word is "error", the card's is
    // "failed", and the unmapped status fell through to "Last run outcome not reported" in the same
    // green as a healthy run. Plant a routine here, write the failure onto its history the way
    // finishRunWith writes one on a throw, and read the card the console draws from it. The
    // schedule is January 1st so nothing fires while the gate is holding the routine.
    if (routinesFor != null) {
      const FAILED_NAME = "Gate probe failed schedule";
      const FAILED_DETAIL = "verify-dashboard staged failure: the run's command exited non-zero";
      let plantedId = null;
      try {
        const made = await gw("createAgentAutomation", { id: routinesFor, spec: { name: FAILED_NAME, prompt: "Planted by the dashboard gate; never fires.", isEnabled: true, trigger: { type: "cron", schedule: "0 4 1 1 *" } } }).catch((e) => ({ error: e.message }));
        const planted = (Array.isArray(made) ? made : [made]).find((entry) => entry?.name === FAILED_NAME) ?? null;
        plantedId = planted?.id ?? null;
        const configPath = plantedId == null ? null : ((await gw("getAgentAutomations", { id: routinesFor }).catch(() => [])) ?? []).find((r) => r.id === plantedId)?.filePath ?? null;
        check(typeof configPath === "string" && configPath.includes("/"), "a routine can be planted on this agent and the host says where its history lives", plantedId == null ? JSON.stringify(made).slice(0, 160) : String(configPath));
        if (typeof configPath === "string" && configPath.includes("/")) {
          const now = Date.now();
          const staged = [{ id: "gate-staged-failure", trigger: "schedule", startedAt: now - 4100, finishedAt: now, status: "error", detail: FAILED_DETAIL }];
          const runsPath = `${configPath.slice(0, configPath.lastIndexOf("/"))}/runs.json`;
          const wrote = await boxNode(`require("fs").writeFileSync(${JSON.stringify(runsPath)}, ${JSON.stringify(JSON.stringify(staged, null, 2) + "\n")})`);
          const readBack = await until(async () => {
            const row = ((await gw("getAgentAutomations", { id: routinesFor }).catch(() => [])) ?? []).find((r) => r.id === plantedId);
            return (row?.runs ?? []).find((entry) => entry.status === "error") ?? null;
          }, 10_000, 1000);
          check(wrote.code === 0 && readBack != null, "and a failed scheduled run staged on that history reads back through the gateway", `exit ${wrote.code}${wrote.out ? ` ${wrote.out.trim().slice(0, 120)}` : ""}; ${readBack == null ? "no error run came back" : `${readBack.status}/${readBack.trigger}`}`);
          // The panel does not repaint on the adapter's own heartbeat, so each attempt closes it and
          // opens it again: the reopen is what re-reads the roster record the heartbeat refreshed.
          // The predicate used to be "a card with that name is on the panel", which the plant itself
          // satisfies on the first iteration -- so the loop returned a card drawn BEFORE the staged
          // run reached the roster record, and the four legs below it read "ready / Never run" and
          // failed on a routine the gateway was already reporting as errored. Wait for the run to be
          // ON the card, and keep the last card seen so a genuinely wrong card still fails in its
          // own words at the cap rather than as "no card".
          let lastCard = null;
          const readCard = async () => {
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(300);
            await page.click("#schedule-button", { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(900);
            return page.evaluate((name) => {
              const card = Array.from(document.querySelectorAll(".routine-card")).find((el) => el.querySelector("h3")?.textContent?.trim() === name);
              if (card == null) return null;
              const pill = card.querySelector(".status-pill");
              return {
                pill: pill?.textContent?.trim() ?? "",
                pillClass: pill?.className ?? "",
                failedLine: card.querySelector(".run-result.failed")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
                text: card.textContent.replace(/\s+/g, " ").trim(),
              };
            }, FAILED_NAME);
          };
          const shown = await until(async () => {
            const card = await readCard();
            if (card != null) lastCard = card;
            return card != null && card.failedLine !== "" ? card : null;
          }, 40_000, 1000) ?? lastCard;
          check(shown != null, "the planted routine reaches the routines panel carrying its failed run", shown == null ? "no card with that name after 40s" : `card found${shown.failedLine === "" ? " but with no failed-run line after 40s" : ""}`);
          if (shown != null) {
            check(/Last run failed/.test(shown.failedLine), "the card says the last run failed, out of the success green", shown.failedLine.slice(0, 160) || shown.text.slice(0, 160));
            check(/on its schedule/.test(shown.failedLine), "and names the trigger, so a run nobody pressed can be told from a test run", shown.failedLine.slice(0, 160));
            check(shown.failedLine.includes(FAILED_DETAIL), "and carries the reason the host stored on the run, because nowhere else reports it", shown.failedLine.slice(0, 200));
            check(/attention/.test(shown.pillClass) && /last run failed/.test(shown.pill), "the pill stops claiming the routine is fine", `class "${shown.pillClass}", text "${shown.pill}"`);
            check(!/Last run outcome not reported/.test(shown.text), "and the failure is not reported as an outcome nobody reported");
          }
        }
      } finally {
        if (plantedId != null) await gw("deleteAgentAutomation", { id: routinesFor, automationId: plantedId }).catch((e) => console.log(`  INFO  planted routine NOT deleted: ${e.message}`));
      }
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);

    // -- The exchange viewer (docs/DASHBOARD-CONTRACT.md) still opens view-only.
    const blurbs = await page.$$(".message-row.is-exchange");
    check(blurbs.length > 0, "an agent-to-agent blurb is present in Atera's conversation", `${blurbs.length} blurb(s)`);
    if (blurbs.length === 0) {
      notReached("no agent-to-agent blurb on the tail to open",
        "the blurb opens the view-only exchange viewer",
        "the viewer shows the exchange itself, both directions",
        "no agent-to-agent message appears as a bubble from you");
    }
    if (blurbs.length > 0) {
      await blurbs.at(-1).click(); await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent?.replace(/\s+/g, " ") ?? "");
      check(/view-only/i.test(text), "the blurb opens the view-only exchange viewer", text.slice(0, 120));
      check(/Chief of staff/.test(text) && /Hey Chief|Thanks for the heads-up/.test(text), "the viewer shows the exchange itself, both directions");
      const bubbles = await page.$$eval(".message-row.is-user", (els) => els.map((e) => e.textContent).filter((t) => /Thanks for the heads-up|Hey Chief, just checking/.test(t)).length);
      check(bubbles === 0, "no agent-to-agent message appears as a bubble from you");
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    }

    // -- GW-14: the palette. Cmd-K opens it only where isGlobalSearchEnabled answered true; a
    // query for a word that is in an agent's transcript returns the host's own hits, and picking
    // a message opens that conversation and flashes the entry.
    await page.keyboard.press("Meta+KeyK"); await page.waitForTimeout(600);
    const paletteOpen = await page.evaluate(() => document.getElementById("palette")?.open === true);
    check(consultedSearch && paletteOpen === (searchEnabled === true), "(g) Cmd-K opens the palette exactly when isGlobalSearchEnabled, consulted at boot, was true", `consulted ${consultedSearch}, host ${searchEnabled}, open ${paletteOpen}`);
    if (paletteOpen) {
      // A word the host's own index holds: ask searchAgents first, so the assertion is about the
      // page carrying the host's answer rather than about this box's transcripts.
      const word = (await gw("searchAgents", { query: "hello", limit: 1 }).catch(() => []))?.length ? "hello" : "ready";
      const hostHits = await gw("searchAgents", { query: word, limit: 20 }).catch(() => []);
      await page.fill("#palette-input", word);
      const rows = await until(() => page.evaluate(() => { const els = document.querySelectorAll("[data-palette-open='message']"); return els.length ? Array.from(els).map((e) => ({ id: e.dataset.contextId, entry: e.dataset.entryId })) : null; }), 10_000, 500);
      check(rows != null && rows.length > 0 && callsTo("searchAgents") >= 1 && callsTo("searchMedia") >= 1, `the palette lists Messages rows from searchAgents for “${word}”`, `${rows?.length ?? 0} row(s) on the page, ${hostHits?.length ?? 0} on the host`);
      if (rows?.length) {
        const target = rows[0];
        const targetName = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === target.id)?.name ?? "";
        await page.click("[data-palette-open='message']");
        const opened = await until(() => page.evaluate((n) => (document.getElementById("room-title")?.textContent === n ? true : null), targetName), 10_000, 500);
        const flashed = await until(() => page.evaluate((e) => (document.querySelector(`.message-row.is-flash[data-message-id="${e}"]`) ? true : null), target.entry), 12_000, 400);
        check(opened === true && flashed === true, "picking a message row opens that conversation and flashes the entry", `${targetName} · ${target.entry} · opened ${opened}, flashed ${flashed}`);
      }
      await page.waitForTimeout(2500);
    }

    // -- GW-10(b): the Updates panel renders the host's version state and its Reset control needs
    // two clicks. Neither a reset nor an update is completed here: only the armed state is asserted.
    await page.click("#settings-button"); await page.waitForTimeout(800);
    const hostStatus = await gw("getHostStatus").catch(() => null);
    const versionRow = await settled("[data-host-version]", /^Reading from the host/, 15_000);
    check(hostStatus?.hostVersion && versionRow != null && versionRow.includes(hostStatus.hostVersion), "the Updates panel renders the host version from getHostStatus", `${versionRow?.slice(0, 80)} vs ${hostStatus?.hostVersion}`);
    const updatesCopy = await page.evaluate(() => document.querySelector("[data-updates-panel]")?.textContent ?? "");
    check(/updateHostNow/.test(updatesCopy) && /locally patched/.test(updatesCopy), "and says why updateHostNow is not wired on this box");
    check((await page.$$("[data-update-box]")).length === 1 && (await page.$$("[data-reset-box]")).length === 1, "Update and Reset controls are present");
    await page.click("[data-reset-box]"); await page.waitForTimeout(400);
    const resetLabel = await page.evaluate(() => document.querySelector("[data-reset-box]")?.textContent ?? "");
    const boxAfterArm = ateraId ? await gw("getForeverBoxStatus", { id: ateraId }).catch(() => null) : null;
    check(/Click again to confirm/.test(resetLabel), "Reset arms on the first click instead of resetting", resetLabel);
    check(boxAfterArm?.state === boxNow?.state, "and the box is untouched after that click", `${boxNow?.state} → ${boxAfterArm?.state}`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);

    // -- qol/panels: no panel scrolls sideways and nothing in one hangs over the card it sits in.
    // The operator's screenshots: the Agent details right column ran its Name, Description and
    // Role controls past the card's right edge (84px, measured at 1440x1000), and several panels
    // scrolled left and right. One sweep for all of them. For the panel and for every card in it:
    // scrollWidth must not exceed clientWidth, and no descendant's right edge may pass the box's
    // own content edge. Content inside its own horizontal scroller -- a pre of attested tool
    // output -- is exempt, because scrolling there instead of widening the card is the shape the
    // fix asks for. A failure prints the worst offender: which box, which element, how far over.
    const panelBleed = async (label, selector) => page.evaluate(({ sel, lbl }) => {
      const root = document.querySelector(sel);
      if (!root) return { label: lbl, found: false };
      // Content edge, not border-box edge: clientLeft skips the border and clientWidth excludes a
      // vertical scrollbar, so a panel that scrolls down is not read as 15px too wide.
      const contentRight = (el) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
      const scan = (box) => {
        const edge = contentRight(box);
        const over = [];
        for (const el of box.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          let ownScroller = false;
          for (let parent = el.parentElement; parent && parent !== box; parent = parent.parentElement) {
            const x = getComputedStyle(parent).overflowX;
            if (x === "auto" || x === "scroll") { ownScroller = true; break; }
          }
          if (ownScroller) continue;
          const past = Math.round(rect.right - edge);
          if (past > 1) over.push({ past, what: `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : ""}`, text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) });
        }
        over.sort((a, b) => b.past - a.past);
        return { scroll: box.scrollWidth - box.clientWidth, worst: over[0] ?? null };
      };
      const boxes = [{ name: "panel", el: root }];
      root.querySelectorAll(".panel-card, .settings-section, .routine-card, .plugin-card, .marketplace-card, .file-tile, .empty-state")
        .forEach((el, i) => boxes.push({ name: `${String(el.className).trim().split(/\s+/)[0]}#${i}`, el }));
      const bad = boxes.map((b) => ({ name: b.name, ...scan(b.el) })).filter((b) => b.scroll > 1 || b.worst);
      bad.sort((a, b) => (b.worst?.past ?? b.scroll) - (a.worst?.past ?? a.scroll));
      // A closed dialog keeps its markup at zero size, where nothing can bleed and the sweep
      // would pass having measured nothing. The width is what says the panel was really open.
      return { label: lbl, found: true, width: Math.round(root.getBoundingClientRect().width), boxes: boxes.length, bad: bad.slice(0, 3) };
    }, { sel: selector, lbl: label });
    // Both dialogs are closed by the close() their own close buttons call, never by Escape: Escape
    // reaches whatever the last click left focused, and a modal left up swallows the next sweep's
    // click on the control behind it. Files opens the desktop dialog, so the hop off it has to
    // clear that one as well as the panel dialog.
    const closeDialogs = async () => {
      await page.evaluate(() => { document.getElementById("panel-dialog")?.close(); document.getElementById("desktop-dialog")?.close(); });
      await page.waitForTimeout(400);
    };
    const sweepPanel = async (label, open, selector = "#panel-content") => {
      await closeDialogs();
      const opened = await open().then(() => true).catch((error) => String(error?.message ?? error).slice(0, 90));
      if (opened !== true) { check(false, `the ${label} panel opens for the bleed sweep`, String(opened)); return; }
      await page.waitForTimeout(1500);
      const seen = await panelBleed(label, selector);
      const worst = seen.bad?.[0] ?? null;
      check(seen.found === true && seen.width > 0 && (seen.bad?.length ?? 0) === 0, `no horizontal scroll or bleed in the ${label} panel`,
        worst
          ? `${worst.name} scrolls ${worst.scroll}px${worst.worst ? `, ${worst.worst.what} is ${worst.worst.past}px past its edge ("${worst.worst.text}")` : ""}`
          : !seen.found ? `${selector} not on the page`
            : seen.width > 0 ? `${seen.boxes} box(es) measured across ${seen.width}px` : "the panel never opened");
    };
    await sweepPanel("Marketplace", () => page.click('[data-capability="marketplace"]', { timeout: 8000 }));
    // #room-menu opens Room roster when the active context is the room and Agent details otherwise,
    // so this asserts which panel it got before measuring it: a roster measured under the label
    // "Agent details" would pass the one panel the operator's screenshot was of without touching it.
    await sweepPanel("Agent details", async () => {
      await page.click("#room-menu", { timeout: 8000 });
      await page.waitForTimeout(900);
      const eyebrow = await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent?.trim() ?? "");
      const roleRow = await page.$("[data-save-role]");
      if (eyebrow !== "Agent details" || roleRow == null) throw new Error(`opened “${eyebrow || "nothing"}”, not Agent details`);
    });
    await sweepPanel("Routines", () => page.click('[data-capability="routines"]', { timeout: 8000 }));
    await sweepPanel("Skills", () => page.click('[data-capability="skills"]', { timeout: 8000 }));
    // Files is the desktop dialog rather than the panel dialog: the capability button calls
    // openDesktop("files"), so the box measured is that dialog's own file view.
    await sweepPanel("Files", () => page.click('[data-capability="files"]', { timeout: 8000 }), "#desktop-dialog .files-view");
    await sweepPanel("Settings", () => page.click("#settings-button", { timeout: 8000 }));
    // Claim provenance opens from an evidence chip in the transcript and fills from getEvidence,
    // so it is measured only once the receipts are in it -- an empty body has nothing to bleed.
    await sweepPanel("Claim provenance", async () => {
      for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(600);
      const sweepChips = await page.$$(".evidence-chip");
      if (sweepChips.length === 0) throw new Error("no evidence chip in the transcript to open");
      const chip = sweepChips.at(-1);
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      const filled = await until(async () => {
        const body = await page.evaluate(() => document.querySelector("[data-evidence-body]")?.textContent ?? "");
        return body && !/Reading the receipts from the host/.test(body) ? body : null;
      }, 30_000, 1000);
      if (!filled) throw new Error("getEvidence did not fill the disclosure within 30s");
    });
    await closeDialogs();

    // -- CP-10 item 2 / GW-11: the masked credential card. The host only writes a secret-request
    // entry when an agent asks for one, which needs a model turn this gate will not spend, so the
    // entry itself is synthetic: getAgentTranscriptTail's answer is intercepted on its way into
    // the page and one entry is appended, in the host's own shape (send-message-tool.ts builds
    // { type:"secret-request", secretRequest:{ label, description, target:{ kind, platform,
    // field } } }). Everything downstream of that is the real thing -- the adapter's cardOf, the
    // card render in app.js -- so this asserts the render, not a fixture. Nothing is submitted:
    // the submit path is pinned against a stub in tests/machine-room-connectors.test.mjs.
    const SECRET_PROBE_ENTRY = "gate-secret-request-probe";
    await page.route("**/api/getAgentTranscriptTail", async (route) => {
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (body && Array.isArray(body.entries) && body.entries.length > 0) {
        const last = body.entries.at(-1);
        body.entries = [...body.entries, {
          id: SECRET_PROBE_ENTRY,
          kind: "send-message",
          timestampMs: Number(last?.timestampMs ?? Date.now()) + 1,
          author: last?.author ?? null,
          message: {
            type: "secret-request",
            secretRequest: {
              // No description: the card then has to write its own custody sentence, which is the
              // half of this render worth asserting.
              label: "the Slack bot token",
              target: { kind: "channel-credential", platform: "slack", field: "bot_token" },
            },
          },
        }];
      }
      // Only what the page needs. Spreading the upstream headers back over a rewritten body
      // re-sends its framing (ui/server.mjs ends the response with no content-length, so Node
      // frames it chunked) for a payload of a different length.
      await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(body ?? {}) });
    });
    // Leave and come back so the adapter reads the tail again through the interception.
    const secretProbeId = await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null);
    const otherId = await page.evaluate((id) => (Array.from(document.querySelectorAll(".worker-card[data-context-id]")).map((e) => e.dataset.contextId).find((x) => x !== id) ?? null), secretProbeId);
    if (otherId) { await page.click(`.worker-card[data-context-id="${otherId}"]`).catch(() => {}); await page.waitForTimeout(3000); }
    if (secretProbeId) { await page.click(`.worker-card[data-context-id="${secretProbeId}"]`).catch(() => {}); }
    const secretCardHtml = await until(() => page.evaluate((entry) => {
      const el = document.querySelector(`.message-row[data-message-id="${entry}"]`);
      return el ? el.outerHTML : null;
    }, SECRET_PROBE_ENTRY), 20_000, 1000);
    check(secretCardHtml != null, "a host credential request renders as its own card in the transcript", secretCardHtml ? "drawn" : "no card after 20s");
    if (secretCardHtml) {
      check(/asked for/i.test(secretCardHtml) && /the Slack bot token/.test(secretCardHtml), "the card says what the agent asked for", (/<strong>([^<]*)<\/strong>/.exec(secretCardHtml) ?? ["", "?"])[1].slice(0, 90));
      check(/type="password"/.test(secretCardHtml) && new RegExp(`data-secret-input="${SECRET_PROBE_ENTRY}"`).test(secretCardHtml), "and draws a masked input carrying the entry id submitSecret needs");
      check(new RegExp(`data-submit-secret="${SECRET_PROBE_ENTRY}"`).test(secretCardHtml), "with a submit that names that same entry id");
      check(!/Answer this in the host app/.test(secretCardHtml), "and no longer sends the operator to the host app");
      check(!/value=/.test(secretCardHtml) && /credential store/.test(secretCardHtml) && /never reaches the model/.test(secretCardHtml), "the input carries no value and the card says where the value goes");
    }
    // The interception comes off and the tail is read once more, so nothing synthetic is on
    // screen for the no-flash window below.
    await page.unroute("**/api/getAgentTranscriptTail");
    if (otherId) { await page.click(`.worker-card[data-context-id="${otherId}"]`).catch(() => {}); await page.waitForTimeout(3000); }
    if (secretProbeId) { await page.click(`.worker-card[data-context-id="${secretProbeId}"]`).catch(() => {}); await page.waitForTimeout(4000); }
    const secretGone = await until(() => page.evaluate((entry) => (document.querySelector(`.message-row[data-message-id="${entry}"]`) ? null : true), SECRET_PROBE_ENTRY), 20_000, 1000);
    check(secretGone === true, "and the synthetic request is off the screen again before the idle window");

    // -- The screen must not flash: the adapter emits only when the transcript or roster moved,
    // so an idle window covering a 15s heartbeat must rebuild the transcript zero times.
    await page.evaluate(() => {
      window.__rebuilds = 0;
      new MutationObserver((records) => { window.__rebuilds += records.length; })
        .observe(document.getElementById("transcript"), { childList: true });
    });
    await page.waitForTimeout(18_000);
    const rebuilds = await page.evaluate(() => window.__rebuilds);
    check(rebuilds === 0, "an idle heartbeat redraws nothing (no flash)", `${rebuilds} transcript mutation(s) in 18s`);
  }
  // -- qol/vnc-paste: the desktop pane's clipboard ---------------------------------------------
  // Two questions. Does the vnc.html the relay serves for the pane carry the bridge -- once, with
  // the assets beside it untouched -- and does a paste aimed at the open pane actually reach the
  // frame. The second is read from inside the frame rather than inferred: a listener goes on the
  // iframe's own window, a paste event is dispatched on the document the way a browser dispatches
  // one, and what arrived on the other side is read back. Then the panel's own line is checked,
  // because that line is this feature's receipt: the desktop dialog is modal, so an ordinary toast
  // would be behind its backdrop.
  if (!OFFLINE && !LEAKS && !TEACH) {
    const vncPage = await fetch(`${GATEWAY}/vnc/1/vnc.html`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const markers = vncPage.split("titanbot-vnc-bridge").length - 1;
    check(markers === 1, "VNCPASTE-1: the vnc.html the relay serves carries the clipboard bridge exactly once", `${markers} marker(s) in ${vncPage.length} bytes`);
    check(vncPage.includes("clipboardPasteFrom") && vncPage.includes("titanbot-vnc-paste"), "and it is the paste half, not just the style");
    check(/#noVNC_control_bar_anchor[^{]*\{[^}]*display: none/.test(vncPage), "and noVNC's own control bar is hidden inside the pane");
    const vncAsset = await fetch(`${GATEWAY}/vnc/1/app/ui.js`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    check(vncAsset.length > 0 && !vncAsset.includes("titanbot-vnc-bridge"), "VNCPASTE-2: the client's own assets come through the relay untouched", `${vncAsset.length} bytes of app/ui.js`);

    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
    await page.waitForTimeout(400);
    await page.click("#rail-screen .rail-screen-button", { timeout: 10_000 }).catch(() => {});
    const paneLive = await until(() => page.evaluate(() => {
      const frame = document.querySelector("#desktop-window iframe[data-box-vnc]");
      const root = frame?.contentDocument?.documentElement;
      return root && root.classList.contains("noVNC_connected") ? true : null;
    }), 60_000, 1500);
    check(paneLive === true, "VNCPASTE-3: the desktop pane's frame connects to the box", paneLive === true ? "" : "no connected noVNC in 60s");
    if (paneLive === true) {
      const probe = await page.evaluate(async () => {
        const frame = document.querySelector("#desktop-window iframe[data-box-vnc]");
        const seen = [];
        frame.contentWindow.addEventListener("message", (event) => {
          if (event.data && event.data.type === "titanbot-vnc-paste") seen.push(event.data.text);
        });
        document.getElementById("desktop-window").dispatchEvent(new MouseEvent("mouseenter"));
        const text = "gate paste probe";
        const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, "clipboardData", { value: { getData: () => text, items: [] } });
        document.dispatchEvent(pasteEvent);
        await new Promise((resolve) => setTimeout(resolve, 800));
        return { seen, prevented: pasteEvent.defaultPrevented, note: document.getElementById("desktop-paste-note")?.textContent ?? "" };
      });
      check(probe.seen.length === 1 && probe.seen[0] === "gate paste probe", "VNCPASTE-4: a paste on the open pane is posted into the frame", JSON.stringify(probe.seen));
      check(probe.prevented === true, "and is taken off the page rather than pasted twice");
      const said = await until(() => page.evaluate(() => {
        const line = document.getElementById("desktop-paste-note")?.textContent ?? "";
        return /Pasted \d+ characters into the box/.test(line) ? line : null;
      }), 12_000, 500);
      check(said != null, "VNCPASTE-5: and the pane says so on its own line, where a modal's backdrop cannot hide it", said ?? `line read: ${probe.note}`);
      // The way out, taken the way an operator with no keyboard would take it. The chord is not
      // enough on its own -- Chrome reads Cmd/Ctrl+Shift+B as Show Bookmarks Bar -- and hiding
      // noVNC's control bar anchor takes the client's own drag handle with it, so this button is
      // the only pointer route left to the clipboard panel underneath.
      const barBack = await page.evaluate(async () => {
        document.getElementById("desktop-vnc-bar")?.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        const root = document.querySelector("#desktop-window iframe[data-box-vnc]")?.contentDocument?.documentElement;
        return root == null ? null : root.classList.contains("titanbot-vnc-bar");
      });
      check(barBack === true, "VNCPASTE-6: the pane's own button brings noVNC's control bar back, with no keyboard", String(barBack));
    }
  }
  check(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
} catch (error) {
  check(false, "dashboard gate", error.message);
} finally {
  await browser.close();
  // BOTS-1's leftovers first: the imported agent, and the skills that import added to the
  // box-wide library. The library sweep uses the imported agent while it still exists, because
  // getAgentWorkflows is addressed by agent id and the library outlives the agent.
  if (botAgentId || botLibraryBefore) {
    const reader = botAgentId ?? probeAgentId ?? (((await gw("listAgents").catch(() => [])) ?? [])[0] ?? {}).id ?? null;
    if (reader && botLibraryBefore) {
      const added = (await libraryIds(reader).catch(() => [])).filter((id) => !botLibraryBefore.includes(id));
      for (const workflowId of added) await gw("deleteAgentWorkflow", { id: reader, workflowId }).catch((e) => console.log(`  INFO  imported bot skill ${workflowId} NOT deleted: ${e.message}`));
      console.log(`  INFO  ${added.length} skill(s) the bot import added swept from the shared library`);
    } else if (botLibraryBefore == null) console.log("  INFO  no library snapshot for the bot import; its skills were NOT swept");
    if (botAgentId) await gw("deleteAgent", { id: botAgentId }).then(() => console.log("  INFO  imported bot agent deleted")).catch((e) => console.log(`  INFO  imported bot agent NOT deleted: ${e.message}`));
  }
  if (probeAgentId && libraryBefore) {
    const added = (await libraryIds(probeAgentId).catch(() => [])).filter((id) => !libraryBefore.includes(id));
    for (const workflowId of added) await gw("deleteAgentWorkflow", { id: probeAgentId, workflowId }).catch((e) => console.log(`  INFO  workflow ${workflowId} NOT deleted: ${e.message}`));
    const left = (await libraryIds(probeAgentId).catch(() => [])).filter((id) => !libraryBefore.includes(id));
    check(left.length === 0, "every skill the gate imported or ported is gone from the shared library", `${added.length} removed, ${left.length} left`);
  } else if (probeAgentId) console.log("  INFO  workflow library snapshot missing; imported skills NOT swept");
  if (copyAgentId) await gw("deleteAgent", { id: copyAgentId }).then(() => console.log("  INFO  duplicate copy swept")).catch((e) => console.log(`  INFO  duplicate copy NOT deleted: ${e.message}`));
  // The recording has to be stopped BEFORE the agent is deleted, and on every exit path. Any throw
  // in the teach pass drops straight into this block with the host still holding `active`, and the
  // host's start() short-circuits on any live recording: every later startTeachRecording, for any
  // agent, comes back as that dead one for the full ten-minute cap. When the cap does fire it
  // saves and dispatches a learning turn for an agent that no longer exists, leaving a signed
  // queue file under a scope no live agent hashes to, which recoverPending can neither deliver nor
  // quarantine. Same order scripts/verify-teach.mjs uses: stop, wait for idle, sweep the scope.
  if (TEACH && probeAgentId) {
    await gw("stopTeachRecording", { agentId: probeAgentId, save: false }).catch(() => {});
    const idle = await until(async () => ((await gw("getTeachRecordingStatus").catch(() => null))?.state === "idle" ? true : null), 15_000, 1000);
    console.log(`  INFO  teach recording ${idle ? "is idle on the host" : "is NOT idle on the host; the box may still be recording"}`);
    const scope = createHash("sha256").update(probeAgentId).digest("hex");
    await box(`rm -rf /workspace/teach-sessions/queues/${scope}`).then(() => console.log(`  INFO  teach queue scope ${scope.slice(0, 12)} swept`)).catch(() => {});
  }
  if (probeAgentId) await gw("deleteAgent", { id: probeAgentId }).then(() => console.log("  INFO  probe agent deleted")).catch((e) => console.log(`  INFO  probe agent NOT deleted: ${e.message}`));
  // The probe connector and anything the gate stored for it, in the one order that works: the
  // host resolves a connector secret through connectors.json, so the row has to be back in the
  // file before the value can be taken out of the store, and only then does the row go.
  if (probeSecretStored || probeConnectorAdded) {
    const writeConnectors = (servers) => fetch(`${GATEWAY}/connectors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpServers: servers }) }).catch(() => null);
    const held = await relay("/connectors").catch(() => null);
    const map = held?.mcpServers;
    // This POST REPLACES connectors.json, and ui/server.mjs readConnectors answers
    // { mcpServers: {} } when its `docker exec cat` fails -- which is exactly what a box mid-
    // restart looks like, and this wave's own deploy step restarts it. Rebuilding the file from
    // that read would wipe the operator's connectors, localfiles included. This box always has at
    // least localfiles configured, so an empty or non-object read here is a failed read, never an
    // empty file: nothing is written and the probe row is left for the next run to sweep.
    if (map == null || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) {
      console.log("  INFO  connectors.json came back empty or unreadable; probe connector NOT swept and nothing was written to the file");
    } else {
      const servers = { ...map };
      if (probeSecretStored) {
        if (servers[PROBE_CONNECTOR] == null) {
          servers[PROBE_CONNECTOR] = { command: "node", args: [`/workspace/${PROBE_MCP_FILE}`], env: { PROBE_TOKEN: "" } };
          await writeConnectors(servers);
        }
        const gone = await fetch(`${GATEWAY}/api/deleteConnectorSecret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server: PROBE_CONNECTOR, field: "PROBE_TOKEN" }) }).then((r) => r.ok).catch(() => false);
        console.log(`  INFO  probe connector secret ${gone ? "deleted from" : "NOT deleted from"} the host store`);
      }
      delete servers[PROBE_CONNECTOR];
      const put = await writeConnectors(servers);
      await fetch(`${GATEWAY}/api/refreshMcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
      console.log(`  INFO  probe connector ${put?.ok ? "swept from" : "NOT removed from"} connectors.json`);
    }
  }
  // MARKET-1: the catalog entry the Add check wrote, if the Uninstall never ran. Same rule as the
  // probe connector above -- an empty or unreadable connectors.json is a failed read on this box,
  // never an empty file, so nothing is written and the row is left for the next run to sweep.
  if (tinyfishAdded) {
    const held = await relay("/connectors").catch(() => null);
    const map = held?.mcpServers;
    if (map == null || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) {
      console.log("  INFO  connectors.json came back empty or unreadable; the gate's tinyfish row was NOT swept and nothing was written to the file");
    } else {
      const servers = { ...map };
      delete servers.tinyfish;
      const put = await fetch(`${GATEWAY}/connectors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpServers: servers }) }).catch(() => null);
      await fetch(`${GATEWAY}/api/refreshMcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
      console.log(`  INFO  the gate's tinyfish row ${put?.ok ? "swept from" : "NOT removed from"} connectors.json`);
    }
  }
  for (const dir of teachDirsMade) await box(`rm -rf ${dir}`).then(() => console.log(`  INFO  teach session ${dir} swept`)).catch(() => {});
  if (teachSettingTouched) {
    // Back to exactly what the box held. Restoring "1" onto a box that held nothing turned teach
    // recording on for good and called it a restore in the log.
    const ok = await writeSetting("SAND_TEACH", KEEP_TEACH_SETTING ? "1" : teachSettingBefore);
    const left = KEEP_TEACH_SETTING ? "1" : (teachSettingBefore ?? null);
    console.log(`  INFO  SAND_TEACH ${ok ? "left at" : "NOT restored to"} ${JSON.stringify(left)} (found ${JSON.stringify(teachSettingBefore ?? null)})`);
  }
  if (!OFFLINE && !LEAKS && !TEACH) await box(`rm -f /workspace/${PROBE_MCP_FILE}`).catch(() => {});
  if (previousRow) { await relay("/endpoints/use", { id: previousRow.id }).catch(() => {}); console.log(`  INFO  box restored to ${previousRow.name}`); }
  else console.log("  INFO  box left where the gate found it (no catalog row matched the live endpoint)");
}
console.log(`\n${passes} PASS / ${failures} FAIL / ${notReachedCount} not reached`);
console.log(`${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
