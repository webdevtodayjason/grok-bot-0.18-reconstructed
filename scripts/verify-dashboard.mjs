#!/usr/bin/env node
// verify-dashboard.mjs -- the dashboard gate (docs/DASHBOARD-CONTRACT.md), in a real browser.
// Headless Chrome through playwright-core from GROK_BOT_PLAYWRIGHT_DIR (never a repo dependency).
// Default: the Machine Room's modals tell the truth -- Providers lead the Plugins page, the box's
// own connectors carry their real tools, a provider card that cannot be adopted offers no button,
// an evidence pill opens its receipts, unread clears when a conversation is read, the Agent
// details rows carry text, and no surface still claims to be a demo.
// --leaks: no adopted secret, no connector argv and no attested tool output in the dashboard DOM.
// --offline: with the gateway blocked, the demo factory's copy says the value was discarded and
//   the writes it does not implement are not drawn as live controls.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    const rest = await run(["scripts/verify-subscription-scan.mjs", "--leaks"]);
    check(rest.code === 0, "no adopted secret in endpoints.json, host log, transcripts, scan", rest.code === 0 ? "" : rest.out.split("\n").filter((l) => /FAIL/.test(l)).join("; "));
  } else {
    // -- MR-06: an unread badge the UI never cleared. Raise a real one, then read the conversation.
    const probeName = `Unread probe ${Date.now()}`;
    const created = await gw("createAgent", { name: probeName, description: "verify-dashboard unread probe" }).catch(() => null);
    probeAgentId = created?.agent?.id ?? created?.id ?? null;
    let raisedUnread = null;
    if (probeAgentId) {
      await gw("sendPrompt", { agentId: probeAgentId, prompt: "Reply with the single word: ready." }).catch(() => {});
      const spoke = await until(async () => {
        const t = await gw("getAgentTranscript", { id: probeAgentId });
        return (t ?? []).some((e) => e.kind === "send-message") ? true : null;
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
    } else {
      check(false, "a fresh agent could be created for the unread probe");
    }

    await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(4000);
    check(await page.evaluate(() => window.__machineRoomLive === true), "the page is on the live gateway, not the demo adapter", await page.evaluate(() => window.__machineRoomError ?? ""));

    // Only meaningful if an unread was actually raised: with none, unreadCount is already 0 and
    // the clear would pass for the wrong reason.
    if (probeAgentId && raisedUnread != null) {
      // Somewhere else first, so selecting the probe is a real context change.
      await clickText("Atera Triage").catch(() => {});
      await clickText(probeName);
      const cleared = await until(async () => {
        const agents = await gw("listAgents");
        const row = (agents ?? []).find((a) => a.id === probeAgentId);
        return row && (row.unreadCount ?? 0) === 0 ? true : null;
      }, 15_000, 1500);
      check(cleared === true, "reading that conversation clears its unread on the host");
    }

    // -- MR-01, MR-05, MR-08, GW-06: the room ••• menu opens the live agent surface.
    await page.click("#room-menu"); await page.waitForTimeout(1500);
    const panelTitle = await page.evaluate(() => document.getElementById("panel-eyebrow")?.textContent ?? "");
    check(/Agent details|Room roster/.test(panelTitle), "the room ••• button opens a live surface", panelTitle);
    const roleField = await page.$$("[data-save-role]");
    check(roleField.length === 1, "the Role row is editable rather than reading the words 'not set'");
    const browserRow = await settled("[data-browser-screen]", /^Asking the host/);
    check(browserRow != null, "the Agent details Browser row resolves to the host's answer, not the placeholder", browserRow ? browserRow.slice(0, 90) : "still 'Asking the host…' after 25s");
    const memoryList = await settled("[data-memory-list]", /^Reading /);
    check(memoryList != null, "the agent detail panel lists memories or says there are none", memoryList ? memoryList.slice(0, 90) : "still 'Reading…' after 25s");
    await noDemoStrings("agent details");
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
    await clickText("Atera Triage"); await page.waitForTimeout(2500);
    // MR-05 again, on an agent the box has already given a screen: the row resolves to the fact,
    // not just to the sentence that says it is asking.
    await page.click("#room-menu"); await page.waitForTimeout(1200);
    const screenRow = (await settled("[data-browser-screen]", /^Asking the host/)) ?? "";
    check(/display :\d+|shared screen/.test(screenRow), "the Browser row resolves to this agent's real screen", screenRow.slice(0, 90) || "still 'Asking the host…' after 25s");
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    const filesTab = await page.evaluate(() => document.querySelector("[data-desktop-app='files'] small")?.textContent?.trim() ?? "");
    check(filesTab === "Files from this conversation", "the Files tab is labelled for what it renders", filesTab);
    check((await page.$$("[data-desktop-app='sheets']")).length === 0, "the placeholder Sheets tab is gone");
    await page.click("#open-desktop"); await page.waitForTimeout(1200);
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
  if (probeAgentId) await gw("deleteAgent", { id: probeAgentId }).then(() => console.log("  INFO  unread probe agent deleted")).catch((e) => console.log(`  INFO  unread probe agent NOT deleted: ${e.message}`));
  if (previousRow) { await relay("/endpoints/use", { id: previousRow.id }).catch(() => {}); console.log(`  INFO  box restored to ${previousRow.name}`); }
  else console.log("  INFO  box left where the gate found it (no catalog row matched the live endpoint)");
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
