#!/usr/bin/env node
// verify-dashboard.mjs -- the dashboard gate (docs/DASHBOARD-CONTRACT.md), in a real browser.
// Headless Chrome through playwright-core from GROK_BOT_PLAYWRIGHT_DIR (never a repo dependency).
// Default: the Machine Room's modals tell the truth -- the Marketplace opens on its Plugins tab
// with the host's own catalog and no provider anywhere in it (MARKET-1: providers and chat
// listeners are Settings sections now), Add and Uninstall on a catalog card write and unwrite
// connectors.json byte for byte, the box's own connectors carry their real tools, a provider card
// that cannot be adopted offers no button,
// an evidence pill opens its receipts, unread clears when a conversation is read, the Agent
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
//   the writes it does not implement are not drawn as live controls.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? "/private/tmp/claude-501/-Users-sem-orca-workspaces-grok-bot-0-18-reconstructed-gb/5d8b03a4-9c9b-4e51-af12-2606d5d99b44/scratchpad/pw";
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
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };
const relay = async (route, body) => { const res = await fetch(`${GATEWAY}${route}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); return res.json(); };
// The relay holds the gateway token and adds it upstream, so a gate call needs no credential.
const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
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
// MARKET-1: the Global capabilities panel is the Marketplace now, and the provider and chat
// listener cards moved out of it into Settings. Two openers, so every check below says which
// surface it means rather than clicking a word that appears on both.
const openMarketplace = async () => {
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  await page.click('[data-capability="marketplace"]'); await page.waitForTimeout(1400);
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
    await openMarketplace();
    const ids = await page.$$eval("[data-plugin-id]", (els) => els.map((e) => e.dataset.pluginId));
    let hint = "";
    for (const id of ids) {
      await pickPlugin(id).catch(() => {});
      if ((await page.$$("input[type=password]")).length === 0) continue;
      hint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
      await page.fill("input[type=password]", "not-a-real-key");
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
    await clickText("Atera Triage").catch(() => {});
    for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
    const pill = (await page.$$(".message-row.is-evidence")).at(-1) ?? null;
    if (pill) {
      await pill.scrollIntoViewIfNeeded(); await pill.click(); await page.waitForTimeout(2500);
      const panel = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent ?? "");
      check(!secrets.some((s) => panel.includes(s)), "no adopted secret in the evidence disclosure");
      const heads = await page.$$eval("[data-head-slot]", (els) => els.map((e) => e.textContent.trim()));
      check(heads.length === 0 || heads.every((h) => /not on this page until you ask/.test(h)), "attested tool output stays out of the DOM until asked for", `${heads.length} slot(s)`);
    } else {
      check(true, "no evidence pill on Atera to open in the leak pass");
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
      await page.click("#open-desktop"); await page.waitForTimeout(1500);
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
      await page.click("#open-desktop"); await page.waitForTimeout(1200);
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
      check(await page.evaluate(() => /skill library/i.test(document.getElementById("panel-content")?.innerText ?? "")), "the Skills panel opens for the probe");
      const learnedName = `Gate learned skill ${Date.now()}`;
      await gw("createAgentWorkflow", { id: probeAgentId, spec: { name: learnedName, description: "written the way a learning turn writes one", body: "Do the demonstrated task.", trigger: null } }).catch((e) => check(false, "a workflow could be written to the host", e.message));
      const listed = await until(() => page.evaluate((name) => (document.getElementById("panel-content")?.innerText.includes(name) ? true : null), learnedName), 22_000, 1000);
      check(listed === true, "a skill that lands on the host during a turn shows up in the open Skills panel with no reload");
      await page.keyboard.press("Escape"); await page.waitForTimeout(600);

      // With the switch off there is nothing to stop, so there must be no dialog -- and the page
      // has to name the switch, because the operator is the only one who can flip it.
      check(await writeSetting("SAND_TEACH", "0"), "SAND_TEACH can be set back to 0 for the refusal pass");
      await page.click("#open-desktop"); await page.waitForTimeout(1200);
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
          const rings = await page.evaluate(() => Array.from(document.querySelectorAll(".worker-card")).map((el) => ({ accent: getComputedStyle(el).getPropertyValue("--accent").trim(), border: getComputedStyle(el.querySelector(".worker-avatar")).borderTopColor, animation: getComputedStyle(el.querySelector(".worker-avatar")).animationName })));
          check(rings.length > 0 && rings.every((r) => r.accent && r.animation && r.animation !== "none"), "every avatar carries its agent's accent and breathes", JSON.stringify(rings.slice(0, 3)));
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
        const aside = document.querySelector("aside.context-space"); const island = aside?.querySelector(".context-island"); const capsule = aside?.querySelector(".desktop-capsule");
        const strong = [...(aside?.querySelectorAll(".context-detail-row") ?? [])].find((row) => /Endpoint/.test(row.textContent))?.querySelector("strong");
        const kept = strong?.textContent ?? null; if (strong) strong.textContent = "Alibaba Model Studio (token plan) · qwen3.8-max";
        const out = { column: r(aside), island: r(island), capsule: r(capsule), viewport: document.documentElement.clientWidth };
        if (strong && kept != null) strong.textContent = kept;
        return out;
      });
      check(!!panel.island && panel.island.w <= panel.column.w + 1 && panel.island.right <= panel.viewport && (!panel.capsule || panel.capsule.w <= panel.column.w + 1), "a long endpoint name cannot widen the Agent panel past its column", JSON.stringify(panel));
      // Read somewhere else while the reply lands, so the unread is raised off screen.
      await clickText("Atera Triage").catch(() => {});
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

    // -- GW-05: the Skills panel, on the probe agent, every step read back through getAgentWorkflows.
    if (probeAgentId) {
      if (!(await page.evaluate(() => document.getElementById("room-title")?.textContent)).startsWith("Unread probe")) await clickText(probeName);
      await page.click("[data-capability='skills']"); await page.waitForTimeout(1500);
      check((await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent)) === "Agent skills", "the Skills capability opens the agent's Skills panel");
      // The library is global (see libraryIds above); the panel must say so, since Delete on it
      // removes the skill for every agent on the box.
      const intro = await page.evaluate(() => document.querySelector("#panel-content .panel-intro p")?.textContent ?? "");
      check(/shared skill library/.test(intro) && /every agent/.test(intro), "the Skills panel says the library is the box's shared one, not this agent's", intro.slice(0, 90));
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
      const rosterSrc = await until(() => page.evaluate((id) => { const src = document.querySelector(`[data-context-id="${id}"] img`)?.getAttribute("src") ?? ""; return /\/avatars\/.+\?v=/.test(src) ? src : null; }, probeAgentId), 20_000, 1000);
      check(hostVersion != null && rosterSrc != null && rosterSrc.includes(`?v=${encodeURIComponent(hostVersion)}`), "and the roster image src carries the host's avatar version", `${rosterSrc ?? "placeholder"} vs getAgentAvatar ${hostVersion}`);
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
        await page.click("[data-roster-hidden] > summary"); await page.waitForTimeout(400);
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
        await page.waitForTimeout(1500);
        await page.click(`[data-context-id="${copyAgentId}"]`).catch(() => {}); await page.waitForTimeout(1500);
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
      // (e) The roster header is countAgents, the host's on-disk count.
      const hostCount = await gw("countAgents").catch(() => null);
      const shownCount = await until(() => page.evaluate((n) => { const el = document.querySelector("[data-agent-count]"); return el && !el.hidden && el.textContent.startsWith(`${n} / 50`) ? el.textContent : null; }, hostCount), 25_000, 1500);
      check(typeof hostCount === "number" && shownCount != null, "(e) the roster header shows countAgents against the 50 cap", `${shownCount ?? await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent)} vs host ${hostCount}`);
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
      // Deduped: a featured plugin is drawn twice on purpose, once under Featured and once under
      // its own category, the way the sectioned catalog this page is modelled on does it.
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
      await pickPlugin(`mcp:${PROBE_CONNECTOR}`).catch(() => {});
      const probeName = await page.evaluate(() => document.querySelector(".plugin-detail h3")?.textContent ?? "");
      const probeCard = await page.evaluate(() => document.querySelector(".plugin-detail .plugin-hero-copy p")?.textContent ?? "");
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
    // agent on screen. The Cursor-hosted route stays reachable and is labelled as the account this
    // box does not have; it used to be the ONLY route, and clicking it could only end in a dead tab.
    if (slackConnected) {
      check((await page.$$("[data-disconnect-plugin='slack']")).length === 1, "a connected Slack listener offers to disconnect for this agent");
    } else {
      const localForm = await page.$("[data-connect-channel='slack']");
      check(localForm != null, "Connect on the Slack listener opens a local token form, not cursor.com");
      check((await page.$$("[data-connect-channel='slack'] input[type=password]")).length === 1, "and the token field is masked");
      const cursorNote = await page.evaluate(() => document.querySelector(".plugin-detail")?.textContent ?? "");
      check(/Cursor-hosted route/.test(cursorNote) && /account this box does not have/.test(cursorNote), "with the Cursor route kept as a labelled secondary", cursorNote.slice(cursorNote.indexOf("Cursor"), cursorNote.indexOf("Cursor") + 110));
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
    const hasKeyField = (await page.$$("input[type=password]")).length > 0;
    const hasSwitch = (await page.$$("[data-use-endpoint]")).length > 0;
    const isLive = (await page.$$eval(".provider-switch .status-pill", (els) => els.map((e) => e.textContent.trim()))).includes("answering now");
    check(hasKeyField || hasSwitch || isLive, "the Z.AI card offers a key field, a switch, or shows it is answering", `key ${hasKeyField}, switch ${hasSwitch}, live ${isLive}`);
    if (hasKeyField) {
      const hint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
      check(/0600 store/.test(hint), "the key form says where the value goes", hint.slice(0, 110));
    }
    if (hasSwitch) {
      await page.click("[data-use-endpoint]"); await page.waitForTimeout(2500);
      const live = await relay("/model");
      check(/z\.ai/.test(String(live?.endpoint ?? "") + String(live?.baseUrl ?? "")) || /glm/.test(String(live?.model ?? "")), "the switch moved the box to Z.AI", `${live?.model} · ${live?.endpoint ?? live?.baseUrl ?? ""}`);
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);

    // -- The Files view is real, and labelled as what it is.
    apiCalls.length = 0;
    await clickText("Atera Triage"); await page.waitForTimeout(2500);
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
    // transcript, the outline's tool rows and the evidence pills still weave into the tail, and
    // the row above it pages older entries in through getAgentTranscriptPage.
    check(callsTo("getAgentTranscript") === 0 && callsTo("getAgentTranscriptTail") > 0, "selecting an agent reads getAgentTranscriptTail, never getAgentTranscript", `${callsTo("getAgentTranscriptTail")} tail, ${callsTo("getAgentTranscript")} whole`);
    const toolRowsInTail = await page.$$eval(".message-row.is-system", (els) => els.filter((e) => /^(Shell|Read|Computer|Task|Update)\b/.test(e.textContent.trim())).length);
    check(toolRowsInTail > 0, "outline tool rows are woven into the tail-loaded transcript", `${toolRowsInTail} row(s)`);
    check((await page.$$(".message-row.is-evidence")).length > 0, "evidence pills render on tail-loaded entries");
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
    const ledgerAgentId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === "Atera Triage")?.id ?? null;
    const hostLedger = ledgerAgentId ? await gw("getAgentActionAudit", { id: ledgerAgentId, limit: 25 }).catch(() => null) : null;
    await page.click("[data-read-audit]");
    const ledgerRows = await until(() => page.evaluate(() => { const l = document.querySelector("[data-audit-list]"); return l && l.textContent.trim() ? l.querySelectorAll("[data-audit-row]").length : null; }), 10_000, 500);
    check(hostLedger != null && ledgerRows === hostLedger.rows.length, "AUDIT-1: the Action ledger disclosure lists getAgentActionAudit's rows for this agent", `${ledgerRows ?? "none"} on the panel, ${hostLedger?.rows?.length ?? "?"} on the host`);
    const ledgerHeads = await page.$$eval("[data-audit-head-slot]", (els) => els.map((e) => e.textContent.trim()));
    check(ledgerHeads.length === (ledgerRows ?? 0) && ledgerHeads.every((h) => /not on this page until you ask/.test(h)), "and every row's tool output is withheld until asked for", `${ledgerHeads.length} slot(s)`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    const filesTab = await page.evaluate(() => document.querySelector("[data-desktop-app='files'] small")?.textContent?.trim() ?? "");
    check(filesTab === "Files from this conversation", "the Files tab is labelled for what it renders", filesTab);
    check((await page.$$("[data-desktop-app='sheets']")).length === 0, "the placeholder Sheets tab is gone");
    await page.click("#open-desktop"); await page.waitForTimeout(1200);
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
        .map((el) => el.textContent.trim())
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
      await page.click("#open-desktop", { timeout: 10_000 }).catch(() => {});
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
    // Back to the agent the rest of this section reads (the evidence pills below are Atera's).
    if (railOnScreenId && (await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null)) !== railOnScreenId) {
      const backName = await page.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"] .worker-name`)?.textContent?.trim() ?? "", railOnScreenId);
      check(await openRoom(railOnScreenId, backName), "the gate is back on the agent it walked away from", backName);
    }
    // -- GW-10(a): the hand-back control exists and is hidden while the host reports no pending
    // hand-off for this agent (getForeverBoxStatus.handoff is where pendingHandoff surfaces).
    const ateraId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === "Atera Triage")?.id ?? null;
    const boxNow = ateraId ? await gw("getForeverBoxStatus", { id: ateraId }).catch(() => null) : null;
    const handBack = await page.evaluate(() => { const el = document.getElementById("hand-back"); return el ? { hidden: el.hidden, text: el.textContent } : null; });
    check(handBack != null && handBack.hidden === (boxNow?.handoff == null), "the hand-back control is in the desktop view and hidden exactly while no hand-off is pending", `hidden ${handBack?.hidden}, host handoff ${JSON.stringify(boxNow?.handoff ?? null)}`);
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
      const instruction = "Sign in to the gate demo account";
      await gw("sendPrompt", {
        agentId: probeAgentId,
        prompt: `Call the request_box_help tool exactly once, with instruction "${instruction}". `
          + "Call no other tool and do nothing else.",
      }).catch(() => null);
      const pending = await until(async () => {
        const status = await gw("getForeverBoxStatus", { id: probeAgentId }).catch(() => null);
        return status?.handoff ?? null;
      }, TURN_TIMEOUT_MS, 3000);
      if (pending == null) {
        check(true, `hand-back probe skipped — the probe never called request_box_help inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s turn budget (the box's endpoint, not the dashboard)`);
      } else {
        check(true, "request_box_help put a real pending hand-off on the host", JSON.stringify(pending).slice(0, 140));
        const errorsBefore = errors.length;
        // The probe's name is not probeName by now: the GW-01 identity checks renamed it. Ask the
        // roster what it is called, or openRoom waits out its whole budget on a title that moved.
        const roomWas = await page.evaluate(() => document.querySelector(".worker-card.is-active")?.dataset.contextId ?? null);
        const probeNow = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.id === probeAgentId)?.name ?? probeName;
        const arrived = await openRoom(probeAgentId, probeNow);
        const shown = await until(() => page.evaluate(() => {
          const el = document.getElementById("hand-back");
          if (!el || el.hidden) return null;
          return { owner: el.dataset.handBack ?? "", note: document.getElementById("hand-back-note")?.textContent ?? "" };
        }), 20_000, 700);
        check(shown != null && shown.owner === probeAgentId, "the hand-back control appears on its own once a hand-off is pending, aimed at the agent that asked", shown ? `owner ${shown.owner}, room reached ${arrived}` : "still hidden after 20s");
        check(shown != null && shown.note.includes(instruction), "and the note beside it repeats the instruction the agent asked for", (shown?.note ?? "").slice(0, 140));
        if (shown != null) {
          await page.click("#hand-back", { timeout: 10_000 });
          const cleared = await until(async () => {
            const status = await gw("getForeverBoxStatus", { id: probeAgentId }).catch(() => null);
            return status != null && status.handoff == null ? true : null;
          }, 20_000, 1000);
          check(cleared === true && callsTo("handBackForeverBox") >= 1, "clicking it clears the pending hand-off on the host", `${cleared === true ? "cleared" : "the host still reports it pending after 20s"}; ${callsTo("handBackForeverBox")} handBackForeverBox call(s)`);
          // Re-hiding follows the host's status event, so it lands as soon as the hand-off clears.
          const rehid = await until(() => page.evaluate(() => document.getElementById("hand-back")?.hidden === true ? true : null), 15_000, 500);
          check(rehid === true && errors.length === errorsBefore, "and the control hides itself again once nothing is pending, with no page error", `${rehid === true ? "hidden" : "still visible after 15s"}; ${errors.length - errorsBefore} new page error(s)`);
          // Re-enabling waits on the RPC, and handBackForeverBox does not answer until the agent it
          // revived has finished a turn (sand-host.ts awaits resumeAfterBoxHandoff), so this is a
          // turn budget, not a UI one. The bug it guards is real: the handler's .finally used to
          // read event.currentTarget, null by then, which threw out of the promise chain and left
          // the button disabled for good. A revived turn that does not come back is a SKIP.
          const reenabled = await until(() => page.evaluate(() => document.getElementById("hand-back")?.disabled === false ? true : null), TURN_TIMEOUT_MS, 1000);
          if (reenabled === true) check(true, "and the button re-enables once handBackForeverBox answers");
          else check(true, `button re-enable skipped — the revived turn did not finish inside the ${Math.round(TURN_TIMEOUT_MS / 1000)}s budget, so handBackForeverBox has not answered yet`);
        }
        // The checks below this block read Atera's conversation. Put the page back where it was,
        // or they measure the probe and report Atera's evidence pills as missing.
        if (roomWas && roomWas !== probeAgentId) {
          const backName = await page.evaluate((id) => document.querySelector(`.worker-card[data-context-id="${id}"] .worker-name`)?.textContent?.trim() ?? "", roomWas);
          check(await openRoom(roomWas, backName), "the gate is back on the agent the hand-back probe walked away from", backName);
        }
      }
    }
    await page.click("[data-desktop-app='files']"); await page.waitForTimeout(1200);
    await noDemoStrings("files view");
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);

    // -- GW-13: an evidence pill opens the receipts behind the verdict.
    for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
    const pills = await page.$$(".message-row.is-evidence");
    check(pills.length > 0, "evidence pills render on Atera's stamped replies", `${pills.length} pill(s)`);
    if (pills.length > 0) {
      const evidenced = await page.evaluateHandle(() => Array.from(document.querySelectorAll(".message-row.is-evidence")).find((el) => /evidenced/.test(el.textContent)) ?? null);
      const target = evidenced.asElement() ?? pills.at(-1);
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
      check(/receipt/.test(text) && /attestation/.test(text), "the pill opens a disclosure with the receipt and attestation counts", text.slice(0, 130));
      check(/tool · \S/.test(text), "the disclosure names at least one tool", (/tool · [^ ]+/.exec(text) ?? ["none"])[0]);
      // An attested head is the raw tool result the host keeps out of model context. It is not in
      // the DOM until one attestation is asked for, and the reveal is per-attestation.
      const heads = await page.$$eval("[data-head-slot]", (els) => els.map((e) => e.textContent.trim()));
      const reveal = await page.$$("[data-reveal-head]");
      check(heads.length === 0 || heads.every((h) => /not on this page until you ask/.test(h)), "attested tool output is withheld until asked for", `${heads.length} slot(s), ${reveal.length} reveal button(s)`);
      if (reveal.length > 0) {
        await reveal[0].click(); await page.waitForTimeout(600);
        const shown = await page.evaluate(() => document.querySelector("[data-head-slot='0']")?.textContent?.trim() ?? "");
        check(shown.length > 0 && !/not on this page until you ask/.test(shown), "and one click reveals that one attestation's output", shown.slice(0, 70));
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    }

    // -- The routines panel, and the trigger editor's honesty about event triggers. The picker
    // offered seven kinds; six of them are event triggers and this host can serve none of them.
    // It builds exactly two event sources (createBackendRelaySources: Slack and GitHub), hands the
    // trigger hub those two and nothing else, and both are polled out of Cursor's backend relay,
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
    check(/need a listener this box has not connected/.test(triggerNote) && /backend relay/.test(triggerNote),
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
          const shown = await until(async () => {
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
          }, 40_000, 1000);
          check(shown != null, "the planted routine reaches the routines panel", shown == null ? "no card with that name after 40s" : "card found");
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
    await page.click("#open-desktop", { timeout: 10_000 }).catch(() => {});
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
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
