// DISCOVER-1, console half. The browser is served the relay half's documented JSON shape; no relay
// implementation is imported, so this gate can land independently of that worktree.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT_DIRS = [
  process.env.GROK_BOT_PLAYWRIGHT_DIR,
  path.join(repoRoot, ".cache/playwright"),
  "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright",
].filter(Boolean);

const STEPS = [
  { id: "hello", label: "Say hello to Titan", done: true, count: 1, of: 1 },
  { id: "voice", label: "Make a voice call", done: false, count: 0, of: 1 },
  { id: "app", label: "Connect an app", done: true, count: 2, of: 1 },
  { id: "memory", label: "Give Titan a memory", done: false, count: 0, of: 1 },
  { id: "screen", label: "Watch his screen", done: true, count: 1, of: 1 },
  { id: "pocket", label: "Put him in your pocket", done: false, count: 0, of: 1 },
];

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

function serveConsole() {
  const root = path.join(repoRoot, "ui/machine-room");
  const state = { hidden: false, gets: 0, hides: 0, shows: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/discover" && request.method === "GET") {
      state.gets += 1;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ steps: STEPS, pct: 50, hidden: state.hidden }));
      return;
    }
    if (url.pathname === "/discover/hide" && request.method === "POST") {
      state.hides += 1;
      state.hidden = true;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/discover/show" && request.method === "POST") {
      state.shows += 1;
      state.hidden = false;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/auth/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ required: false, authenticated: true, operator: true, workspace: { name: "Acme" } }));
      return;
    }
    if (url.pathname === "/allowance") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ used: 0, cap: 100 }));
      return;
    }
    const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
    }
  });
  return { server, state };
}

const roundedRect = (rect) => Object.fromEntries(["x", "y", "width", "height", "right", "bottom"]
  .map((key) => [key, Math.round(rect[key] * 100) / 100]));

test("DISCOVER-1 source owns its seam without app.js", async () => {
  const [html, app, settings] = await Promise.all([
    read("ui/machine-room/index.html"),
    read("ui/machine-room/app.js"),
    read("ui/machine-room/settings.js"),
  ]);
  assert.match(html, /<script src="discover\.js"><\/script>/);
  assert.ok(html.indexOf('src="discover.js"') < html.indexOf('src="settings.js"'), "Settings must see the discover seam at load");
  assert.doesNotMatch(app, /__discover|discover-pill|\/discover/, "DISCOVER-1 may not couple itself to app.js");
  assert.match(settings, /label: "Show the welcome bar"/);
  assert.match(settings, /global\.__discover\?\.show\?\.\(\)/, "the Settings row must use the module that POSTs /discover/show");
});

test("DISCOVER-1 in a real browser at 1440x900 and 390x844", async (t) => {
  const playwrightDir = PLAYWRIGHT_DIRS.find((dir) => existsSync(path.join(dir, "package.json")));
  if (!existsSync(CHROME) || playwrightDir == null) {
    t.skip(`tried Chrome at ${CHROME} and playwright-core under ${PLAYWRIGHT_DIRS.join(", ")}`);
    return;
  }
  const require = createRequire(path.join(playwrightDir, "package.json"));
  const { chromium } = require("playwright-core");
  const { server, state } = serveConsole();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      state.hidden = false;
      const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
      await context.addInitScript(() => { window.__discoverPollMs = 50; });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__discover?.state().steps.length === 6);
      await page.evaluate(() => { document.getElementById("boot-cover")?.setAttribute("hidden", ""); });

      const pillText = await page.locator("#discover-pill").innerText();
      assert.equal(pillText.replace(/\s+/g, " ").trim(), "Welcome to Titanium Bot 50%");
      assert.equal(await page.locator("#allowance-workspace").evaluate((node) => getComputedStyle(node).display), "none",
        "the pill occupies the workspace name's place while it is visible");
      await page.locator("#discover-pill").click();
      const geometry = await page.evaluate(() => {
        const pill = document.getElementById("discover-pill").getBoundingClientRect();
        const menu = document.getElementById("discover-menu").getBoundingClientRect();
        const progress = document.querySelector(".discover-progress").getBoundingClientRect();
        const fill = document.querySelector("[data-discover-fill]").getBoundingClientRect();
        return {
          pill: Object.fromEntries(["x", "y", "width", "height", "right", "bottom"].map((key) => [key, pill[key]])),
          menu: Object.fromEntries(["x", "y", "width", "height", "right", "bottom"].map((key) => [key, menu[key]])),
          progress: { width: progress.width, fillWidth: fill.width },
          rows: document.querySelectorAll("[data-discover-step]").length,
          done: document.querySelectorAll(".discover-step.is-done").length,
          counts: [...document.querySelectorAll(".discover-step-count")].map((node) => node.textContent),
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      const measured = { pill: roundedRect(geometry.pill), menu: roundedRect(geometry.menu) };
      console.log(`    DISCOVER-1 at ${viewport.width}x${viewport.height}: pill ${JSON.stringify(measured.pill)}, sheet ${JSON.stringify(measured.menu)}`);
      assert.equal(geometry.rows, 6);
      assert.equal(geometry.done, 3);
      assert.deepEqual(geometry.counts, ["1/1", "0/1", "2/1", "0/1", "1/1", "0/1"]);
      assert.ok(Math.abs(geometry.progress.fillWidth * 2 - geometry.progress.width) < 1, "50% must fill half the bar");
      assert.equal(geometry.sideways, false);
      if (viewport.width === 390) {
        assert.equal(measured.pill.height, 44, "the phone pill is exactly 44 px high");
        assert.equal(measured.menu.x, 0);
        assert.equal(measured.menu.width, 390, "the phone dropdown is a full-width sheet");
        assert.equal(measured.menu.bottom, 844, "the phone sheet is anchored to the bottom edge");
      } else {
        assert.ok(Math.abs(measured.menu.x - measured.pill.x) < 1, "the desktop dropdown opens under the pill");
        assert.ok(measured.menu.width < 400, "the desktop dropdown remains a dropdown, not a sheet");
      }

      if (viewport.width === 1440) {
        const beforePoll = state.gets;
        await page.waitForTimeout(140);
        assert.ok(state.gets >= beforePoll + 2, "the 60 second production poll repeats while the page is open");
        await page.locator("[data-discover-hide]").click();
        await page.waitForFunction(() => document.getElementById("discover-pill").hidden === true);
        assert.equal(state.hides, 1, "Hide must POST once");

        await page.waitForFunction(() => window.__mrUi?.openPanel && window.__mrSettings?.open, null, { timeout: 30_000 });
        await page.evaluate(() => window.__mrSettings.open("general"));
        await page.waitForSelector('[data-setting-row="welcome-bar"]');
        await page.locator('[data-setting-row="welcome-bar"] [data-settings-action="welcome-show"]').click();
        await page.waitForFunction(() => document.getElementById("discover-pill").hidden === false);
        assert.equal(state.shows, 1, "Show the welcome bar must POST once from Settings");
        await page.evaluate(() => window.__discover.paint({ steps: [], pct: 100, hidden: false }));
        assert.equal(await page.locator("#discover-pill").isHidden(), true, "100% retires the pill even when hidden is false");
      }
      assert.deepEqual(errors.filter((one) => /discover/i.test(one)), []);
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
