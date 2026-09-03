#!/usr/bin/env node
// verify-dashboard.mjs -- the dashboard gate (docs/DASHBOARD-CONTRACT.md), in a real browser.
// Headless Chrome through playwright-core from GROK_BOT_PLAYWRIGHT_DIR (never a repo dependency).
// Default: the Machine Room's modals tell the truth -- Providers lead the Plugins page, the box's
// own connectors carry their real tools, a provider card that cannot be adopted offers no button,
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
// the two attachments) and the skill run.
// --leaks: no adopted secret, no connector argv, no attested tool output and no attachment
//   preview carrying a secret in the dashboard DOM.
// --offline: with the gateway blocked, the demo factory's copy says the value was discarded and
//   the writes it does not implement are not drawn as live controls.
import { execFile } from "node:child_process";
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
// A live turn on a fresh agent is the only honest way to raise an unread count on this host:
// setAgentUnread{isUnread:true} answers {"error":"this.tm.sessionStore.seedSessionActivityFrom
// DbMtime is not a function"} (the false direction works), so the badge cannot be raised
// synthetically. The box answers through whatever endpoint it is already on, so this runs before
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
// A nav click by id, not by text: the sidebar scrolls, and a click at a stale coordinate lands on
// the dialog backdrop, which closes the panel instead of selecting the card.
const pickPlugin = async (id) => { await page.click(`[data-plugin-id="${id}"]`); await page.waitForTimeout(1200); };
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
// The GW-01 Duplicate check's copy, deleted through the panel; swept here if that step did not.
let copyAgentId = null;
// The workflow library is GLOBAL on the box (workflow-store.ts GlobalWorkflowLibrary; per-agent
// state is only the enablement), so a skill this gate imports or ports through the probe agent
// outlives the probe and shows up on every production agent. Snapshot the library once the probe
// exists and delete everything the run added before the probe itself goes.
let libraryBefore = null;
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
    await clickText("Plugins");
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
    await clickText("Plugins");
    for (const id of ["sub:zai", "sub:codex", "mcp:localfiles"]) await pickPlugin(id).catch(() => {});
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

    // -- The Plugins page: Providers, then the box's own connectors, then listeners.
    await clickText("Plugins");
    const titles = await page.$$eval(".plugin-group-title", (els) => els.map((e) => e.textContent.trim()));
    check(titles[0] === "Providers", "Providers section leads the Plugins page", `groups: ${titles.join(", ")}`);
    const order = await page.$$eval(".plugin-sidebar > *", (els) => els.map((e) => e.classList.contains("plugin-group-title") ? `#${e.textContent.trim()}` : e.textContent.trim().slice(0, 18)));
    check(order.indexOf("#Providers") < order.indexOf("#Connectors") || order.indexOf("#Connectors") < 0, "providers listed before connectors");

    // -- MR-02: the Connectors group carries the box's real server and its real tools.
    check(titles.includes("Connectors"), "a Connectors group is present", `groups: ${titles.join(", ")}`);
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
    const connectorBlurb = await page.evaluate(() => document.querySelector(".plugin-detail .plugin-hero-copy p")?.textContent ?? "");
    const argLeaks = [...(connectorSpec?.args ?? []), ...Object.values(connectorSpec?.env ?? {})].filter((v) => String(v).length > 2 && connectorBlurb.includes(String(v)));
    check(argLeaks.length === 0, "the connector card names the executable without echoing its argv or env", `blurb: ${connectorBlurb.slice(0, 110)}`);
    check(/argument\(s\), configured in connectors\.json/.test(connectorBlurb), "and says where the rest of the launch spec lives", connectorBlurb.slice(0, 110));
    const skillsHeading = await page.evaluate(() => Array.from(document.querySelectorAll(".plugin-section-title")).some((e) => /Skills in package/.test(e.textContent)));
    check(skillsHeading === false, "no empty Skills heading over an empty div");

    // -- GW-08 item 2: a listener card shows getAgentChannels for the agent on screen.
    const onScreen = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
    const onScreenId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === onScreen)?.id ?? null;
    const channels = onScreenId ? await gw("getAgentChannels", { id: onScreenId }).catch(() => null) : null;
    await pickPlugin("slack");
    const channelRow = await page.evaluate(() => document.querySelector("[data-channel-state='slack']")?.textContent?.replace(/\s+/g, " ") ?? "");
    const slackConnected = (channels?.connections ?? []).some((c) => c.platform === "slack");
    check(channelRow.includes(onScreen) && new RegExp(slackConnected ? "connected" : "not connected").test(channelRow) && (slackConnected || !/: connected/.test(channelRow)), "the Slack listener card shows this agent's channel state from getAgentChannels", `${onScreen} → ${channelRow.slice(0, 110)}`);

    // -- MR-04: a provider whose route this host cannot adopt offers no Connect button.
    await pickPlugin("sub:claude");
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
      await pickPlugin("sub:minimax");
      const mmButtons = await page.$$("[data-install-plugin]");
      const mmNote = await page.evaluate(() => document.querySelector(".plugin-detail .secure-card-header small")?.textContent?.trim() ?? "");
      check(mmButtons.length === 0, "a CLI-login provider with no login on this Mac shows no Connect button", `${mmButtons.length} button(s)`);
      check(/Nothing to adopt yet/i.test(mmNote), "and says the CLI holds no login instead", mmNote.slice(0, 110));
    } else {
      check(true, "MiniMax is adoptable on this Mac, so the un-adoptable endpoint card is not exercised", `usable ${minimax?.usable}, adopted ${minimax?.adopted}`);
    }
    // -- MR-03: the key form on a card that is definitely NOT adopted, so the hint really renders.
    await pickPlugin("sub:gemini-key");
    const keyHint = await page.evaluate(() => document.querySelector(".plugin-detail .field-hint")?.textContent?.trim() ?? "");
    check(/0600 store/.test(keyHint) && !/discard/i.test(keyHint), "the key form says where the value goes, not that it is discarded", keyHint.slice(0, 120));
    await noDemoStrings("plugins page");

    // -- The Providers switch still moves the box (docs/DASHBOARD-CONTRACT.md).
    await pickPlugin("sub:zai");
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
    // -- GW-10(a): the hand-back control exists and is hidden while the host reports no pending
    // hand-off for this agent (getForeverBoxStatus.handoff is where pendingHandoff surfaces).
    const ateraId = ((await gw("listAgents").catch(() => [])) ?? []).find((a) => a.name === "Atera Triage")?.id ?? null;
    const boxNow = ateraId ? await gw("getForeverBoxStatus", { id: ateraId }).catch(() => null) : null;
    const handBack = await page.evaluate(() => { const el = document.getElementById("hand-back"); return el ? { hidden: el.hidden, text: el.textContent } : null; });
    check(handBack != null && handBack.hidden === (boxNow?.handoff == null), "the hand-back control is in the desktop view and hidden exactly while no hand-off is pending", `hidden ${handBack?.hidden}, host handoff ${JSON.stringify(boxNow?.handoff ?? null)}`);
    // A real click, aimed at the probe agent (no hand-off is pending there, so the host's
    // endHandoff is a no-op): the handler's .finally used to read event.currentTarget, null by
    // then, which threw out of the promise chain and left the button disabled for good.
    if (probeAgentId) {
      const errorsBefore = errors.length;
      await page.evaluate((id) => { const el = document.getElementById("hand-back"); el.dataset.handBack = id; el.hidden = false; el.click(); }, probeAgentId);
      const settled = await until(() => page.evaluate(() => { const el = document.getElementById("hand-back"); return el && !el.disabled ? { hidden: el.hidden } : null; }), 10_000, 400);
      check(settled != null && settled.hidden === true && errors.length === errorsBefore && callsTo("handBackForeverBox") >= 1, "clicking hand-back calls handBackForeverBox, re-enables the button and re-hides it, with no page error", `${settled ? `hidden ${settled.hidden}` : "still disabled after 10s"}; ${errors.length - errorsBefore} new page error(s); ${callsTo("handBackForeverBox")} call(s)`);
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
      await target.click(); await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent?.replace(/\s+/g, " ") ?? "");
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
  check(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
} catch (error) {
  check(false, "dashboard gate", error.message);
} finally {
  await browser.close();
  if (probeAgentId && libraryBefore) {
    const added = (await libraryIds(probeAgentId).catch(() => [])).filter((id) => !libraryBefore.includes(id));
    for (const workflowId of added) await gw("deleteAgentWorkflow", { id: probeAgentId, workflowId }).catch((e) => console.log(`  INFO  workflow ${workflowId} NOT deleted: ${e.message}`));
    const left = (await libraryIds(probeAgentId).catch(() => [])).filter((id) => !libraryBefore.includes(id));
    check(left.length === 0, "every skill the gate imported or ported is gone from the shared library", `${added.length} removed, ${left.length} left`);
  } else if (probeAgentId) console.log("  INFO  workflow library snapshot missing; imported skills NOT swept");
  if (copyAgentId) await gw("deleteAgent", { id: copyAgentId }).then(() => console.log("  INFO  duplicate copy swept")).catch((e) => console.log(`  INFO  duplicate copy NOT deleted: ${e.message}`));
  if (probeAgentId) await gw("deleteAgent", { id: probeAgentId }).then(() => console.log("  INFO  unread probe agent deleted")).catch((e) => console.log(`  INFO  unread probe agent NOT deleted: ${e.message}`));
  if (previousRow) { await relay("/endpoints/use", { id: previousRow.id }).catch(() => {}); console.log(`  INFO  box restored to ${previousRow.name}`); }
  else console.log("  INFO  box left where the gate found it (no catalog row matched the live endpoint)");
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
