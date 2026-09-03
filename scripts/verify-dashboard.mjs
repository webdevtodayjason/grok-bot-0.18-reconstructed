#!/usr/bin/env node
// verify-dashboard.mjs -- the dashboard gate (docs/DASHBOARD-CONTRACT.md), in a real browser.
// Headless Chrome through playwright-core from GROK_BOT_PLAYWRIGHT_DIR (never a repo dependency).
// Default: Providers section leads the Plugins page, an adopted provider offers "Use this endpoint"
// and the switch takes (then is undone), and an agent-to-agent blurb opens the view-only viewer.
// --leaks: no adopted secret appears in the dashboard DOM, plus the usual surfaces.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? "/private/tmp/claude-501/-Users-sem-orca-workspaces-grok-bot-0-18-reconstructed-gb/5d8b03a4-9c9b-4e51-af12-2606d5d99b44/scratchpad/pw";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const LEAKS = process.argv.includes("--leaks");
const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");

let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };
const relay = async (route, body) => { const res = await fetch(`${GATEWAY}${route}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); return res.json(); };
const run = (args) => new Promise((resolve) => execFile("node", args, { maxBuffer: 16 << 20, env: process.env, cwd: repoRoot }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
const clickText = async (text) => { const loc = page.getByText(text, { exact: false }).first(); const box = await loc.boundingBox(); if (!box) throw new Error(`not visible: ${text}`); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(1200); };
// The catalog's own live marker names the row to restore; /model alone does not carry the row id.
const startCatalog = await relay("/endpoints").catch(() => null);
const previousRow = startCatalog?.endpoints?.find((e) => e.baseUrl === startCatalog?.live?.baseUrl && e.model === startCatalog?.live?.model) ?? null;
try {
  await page.goto(`${GATEWAY}/`, { waitUntil: "load" }); await page.waitForTimeout(4000);
  if (LEAKS) {
    const { storedSecrets } = await import(path.join(repoRoot, "ui", "subscriptions.mjs"));
    const secrets = await storedSecrets();
    await clickText("Plugins");
    for (const name of ["Z.AI GLM", "ChatGPT / Codex"]) await clickText(name).catch(() => {});
    const dom = await page.evaluate(() => document.documentElement.outerHTML + " " + Array.from(document.querySelectorAll("input")).map((i) => i.value).join(" "));
    check(!secrets.some((s) => dom.includes(s)), `no adopted secret in the dashboard DOM (${secrets.length} held)`);
    const rest = await run(["scripts/verify-subscription-scan.mjs", "--leaks"]);
    check(rest.code === 0, "no adopted secret in endpoints.json, host log, transcripts, scan", rest.code === 0 ? "" : rest.out.split("\n").filter((l) => /FAIL/.test(l)).join("; "));
  } else {
    await clickText("Plugins");
    const titles = await page.$$eval(".plugin-group-title", (els) => els.map((e) => e.textContent.trim()));
    check(titles[0] === "Providers", "Providers section leads the Plugins page", `groups: ${titles.join(", ")}`);
    const order = await page.$$eval(".plugin-sidebar > *", (els) => els.map((e) => e.classList.contains("plugin-group-title") ? `#${e.textContent.trim()}` : e.textContent.trim().slice(0, 18)));
    check(order.indexOf("#Providers") < order.indexOf("#Connectors") || order.indexOf("#Connectors") < 0, "providers listed before connectors");
    await clickText("Z.AI GLM");
    const hasKeyField = (await page.$$("input[type=password]")).length > 0;
    const hasSwitch = (await page.$$("[data-use-endpoint]")).length > 0;
    const isLive = (await page.$$eval(".provider-switch .status-pill", (els) => els.map((e) => e.textContent.trim()))).includes("answering now");
    check(hasKeyField || hasSwitch || isLive, "the Z.AI card offers a key field, a switch, or shows it is answering", `key ${hasKeyField}, switch ${hasSwitch}, live ${isLive}`);
    if (hasSwitch) {
      await page.click("[data-use-endpoint]"); await page.waitForTimeout(2500);
      const live = await relay("/model");
      check(/z\.ai/.test(String(live?.endpoint ?? "") + String(live?.baseUrl ?? "")) || /glm/.test(String(live?.model ?? "")), "the switch moved the box to Z.AI", `${live?.model} · ${live?.endpoint ?? live?.baseUrl ?? ""}`);
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await clickText("Atera Triage"); await page.waitForTimeout(2500);
    for (let i = 0; i < 400; i += 1) await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
    const blurbs = await page.$$(".message-row.is-exchange");
    check(blurbs.length > 0, "an agent-to-agent blurb is present in Atera's conversation", `${blurbs.length} blurb(s)`);
    if (blurbs.length > 0) {
      await blurbs.at(-1).click(); await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.getElementById("panel-dialog")?.textContent?.replace(/\s+/g, " ") ?? "");
      check(/view-only/i.test(text), "the blurb opens the view-only exchange viewer", text.slice(0, 120));
      check(/Chief of staff/.test(text) && /Hey Chief|Thanks for the heads-up/.test(text), "the viewer shows the exchange itself, both directions");
      const bubbles = await page.$$eval(".message-row.is-user", (els) => els.map((e) => e.textContent).filter((t) => /Thanks for the heads-up|Hey Chief, just checking/.test(t)).length);
      check(bubbles === 0, "no agent-to-agent message appears as a bubble from you");
    }
  }
  check(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
} catch (error) {
  check(false, "dashboard gate", error.message);
} finally {
  await browser.close();
  if (previousRow) { await relay("/endpoints/use", { id: previousRow.id }).catch(() => {}); console.log(`  INFO  box restored to ${previousRow.name}`); }
  else console.log("  INFO  box left where the gate found it (no catalog row matched the live endpoint)");
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
