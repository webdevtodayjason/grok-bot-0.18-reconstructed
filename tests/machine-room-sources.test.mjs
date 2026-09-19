// SOURCES-1, the console half: where a research answer came from, under the answer.
//
// A tester read a reply and asked "not sure if it was their website or internet search". The line
// this suite renders is the answer to that question, so what has to hold is not that it exists but
// that a person can read it and that reading it tells them nothing false.
//
// Three things are pinned, each one a way the line could mislead or disappear:
//
//   - THE COUNTS ARE THE HOST'S. The summary says what the host counted, never what the open list
//     happens to show. The host caps each list at twelve, so a turn that read forty pages says
//     forty; a summary recomputed from the rows would quietly turn it into a turn that read twelve.
//
//   - IT DOES NOT READ AS A FAULT. Jason reads a prefixed, underlined line under a delivered reply
//     as an error (host-notes-read-as-errors, FOOTER-1). So the computed style is checked, not the
//     intent: no underline anywhere in it, and no red. The reply was delivered; this line is about
//     provenance and says nothing about whether the answer was good.
//
//   - IT FITS THE COLUMN AT BOTH WIDTHS. At 390 the message column IS the screen, and a row that
//     laid a domain, a page name and a route side by side ran off it. Every row's right edge is
//     measured against the message block's, and the block is measured for horizontal scroll.
//
// The renderer is SLICED OUT OF app.js and run, never retyped: a copy in this file would go on
// passing after the console changed. It is rendered over the shipped stylesheets, served flat, so
// the cascade is the one the browser gets.
//
// It is SKIPPED, with a sentence naming what it tried, when Chrome or playwright-core is absent --
// the resolver pattern tests/machine-room-code-chip-pixels.test.mjs already uses. Chromium at a
// 390 viewport is a CSS measurement of one component and not a phone run; what a phone adds
// (WebKit, the safe-area insets) belongs to the phone suite and is not claimed here.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT_CANDIDATES = [
  process.env.GROK_BOT_PLAYWRIGHT,
  path.join(repoRoot, ".cache/playwright/node_modules/playwright-core/index.mjs"),
  // A detached worktree has no .cache of its own; the shared checkout is where it was installed.
  "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright/node_modules/playwright-core/index.mjs",
].filter(Boolean);
const SHOTS = process.env.GROK_BOT_SHOTS ?? path.join(tmpdir(), "sources-line-shots");

const MIME = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

// A turn that read three pages by three different roads and ran two searches. The counts are
// deliberately NOT the list lengths: this is what a capped list looks like from the console's side.
const STAMP = {
  pages: [
    { kind: "page", domain: "acehardware.com", title: "Hex bolts, 1/4 in. to 1/2 in.", route: "fetch" },
    { kind: "page", domain: "fastenal.com", title: "Grade 5 hex cap screws in bulk packs", route: "tinyfish" },
    { kind: "page", domain: "boltdepot.com", route: "browser" },
  ],
  searches: [
    { kind: "search", query: "1/4-20 hex bolt 25 pack in stock", tool: "WebSearch" },
    { kind: "search", query: "grade 5 bolt 25 count near me", tool: "WebSearch" },
  ],
  pageCount: 3,
  searchCount: 2,
};

/** The console's own files, served flat, so every relative url() inside the stylesheets resolves. */
function serveFixture(renderer) {
  const root = path.join(repoRoot, "ui/machine-room");
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/fixture") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(fixtureHtml(renderer));
      return;
    }
    const file = path.join(root, url.pathname.replace(/^\/+/, ""));
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch { response.writeHead(404, { "content-type": "text/plain" }).end("no"); }
  });
}

/**
 * The reply and the line under it, in a real message row. `#transcript` is bounded the way the
 * console's column is on a wide screen and left to the screen on a narrow one, which is the whole
 * point of measuring twice.
 */
function fixtureHtml(renderer) {
  return `<!doctype html><html data-theme="night"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/motion.css">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/backgrounds.css">
<style>body{margin:0;padding:18px;background:#0d1117}
#transcript{max-width:760px}
@media (max-width: 640px){body{padding:10px}#transcript{max-width:none}}
*, *::before, *::after { animation: none !important; transition: none !important; }
</style></head>
<body><main class="transcript" id="transcript"></main><script>
const escapeHtml = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
${renderer}
const stamp = ${JSON.stringify(STAMP)};
document.getElementById("transcript").innerHTML =
  '<article class="message-row"><div class="message-block">'
  + '<div class="message-meta"><strong>Titan</strong><time>now</time></div>'
  + '<div class="message-bubble"><p>Two of the three carry a 25 pack today.</p></div>'
  + sourcesLineMarkup({ id: "m1", sources: stamp })
  + '</div></article>';
window.__fixtureReady = true;
</script></body></html>`;
}

/** What a person sees, and where it sits. Read once closed and once open. */
const PROBE = `(() => {
  const block = document.querySelector(".message-block");
  const note = document.querySelector("[data-sources]");
  if (!note) return { missing: true };
  const summary = note.querySelector("summary") ?? note;
  const round = (n) => Math.round(n * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), right: round(r.right) }; };
  const styleOf = (el) => { const s = getComputedStyle(el); return { color: s.color, decoration: s.textDecorationLine, size: s.fontSize }; };
  // What a person SEES, not what the markup holds. A closed <details> keeps its rows in the DOM,
  // and in current Chrome they keep a stale rect too -- the content is skipped, not unlaid -- so a
  // node count, and a rect check, would both say the list was showing while it was shut.
  // checkVisibility is the question actually being asked: can this be seen.
  const seen = (el) => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
  const all = [...note.querySelectorAll(".sources-row")];
  const rows = all.filter(seen).map((el) => ({
    text: el.textContent, cls: el.className, ...box(el), ...styleOf(el),
  }));
  return {
    open: note.open === true,
    summaryText: summary.textContent,
    summaryBox: box(summary),
    summaryStyle: styleOf(summary),
    noteStyle: styleOf(note),
    rows,
    rowsInMarkup: all.length,
    block: box(block),
    blockScroll: { scrollWidth: block.scrollWidth, clientWidth: block.clientWidth },
    docScroll: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    // Every element inside the line, so an underline cannot hide on a child.
    decorations: [...note.querySelectorAll("*")].map((el) => getComputedStyle(el).textDecorationLine),
  };
})()`;

/** Red is the colour this line must never be: it reports provenance, not a fault. */
function assertNotRed(color, where) {
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  assert.ok(rgb, `${where} has a readable colour, got ${color}`);
  const [r, g, b] = rgb[1].split(",").map((n) => Number(n.trim()));
  assert.ok(!(r > 150 && r > g * 1.8 && r > b * 1.8), `${where} must not read as an error, got ${color}`);
}

test("the sources line renders, opens and stays inside the column at 1440 and at 390", async (t) => {
  const playwright = PLAYWRIGHT_CANDIDATES.find((one) => existsSync(one));
  if (!existsSync(CHROME) || playwright == null) {
    t.skip(`tried Chrome at ${CHROME} and playwright-core at ${PLAYWRIGHT_CANDIDATES.join(", ")}; `
      + "set GROK_BOT_CHROME / GROK_BOT_PLAYWRIGHT to run the render leg");
    return;
  }
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const from = app.indexOf("  const SOURCE_ROUTE_WORDS = {");
  const lineStart = app.indexOf("  function sourcesLineMarkup(message) {");
  assert.ok(from > 0 && lineStart > from, "app.js must still define the sources renderer");
  const to = app.indexOf("\n  }\n", lineStart) + 4;
  const renderer = app.slice(from, to);

  mkdirSync(SHOTS, { recursive: true });
  const server = serveFixture(renderer);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(playwright);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const shots = [];
  try {
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        // Every gate this repo runs says who it is.
        userAgent: "titanbot-gate/machine-room-sources",
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/fixture`, { waitUntil: "load" });
      await page.waitForFunction("window.__fixtureReady === true", null, { timeout: 8000 });
      assert.deepEqual(errors, [], `the fixture must paint without a page error at ${width}`);

      const closed = await page.evaluate(PROBE);
      assert.ok(!closed.missing, `the line must be drawn at ${width}`);
      assert.equal(closed.open, false, `the line starts closed at ${width}`);
      // The host's counts, not the list's lengths: three pages are listed, three are counted, and
      // two searches are counted -- a summary built from rows would say five of something.
      assert.equal(closed.summaryText.trim(), "Sources: 3 pages, 2 searches", `the summary reads in plain words at ${width}`);
      assert.equal(closed.rows.length, 0, `nothing is listed until it is opened at ${width}`);
      assert.equal(closed.rowsInMarkup, 5, `the list is there, closed, at ${width}`);
      assert.ok(closed.summaryBox.w > 0 && closed.summaryBox.h > 0, `the summary has a box a person can hit at ${width}`);
      assert.ok(closed.summaryBox.right <= closed.block.right + 1,
        `the summary stays inside the message column at ${width}: ${closed.summaryBox.right} vs ${closed.block.right}`);
      assertNotRed(closed.summaryStyle.color, `the summary at ${width}`);
      assert.equal(closed.summaryStyle.decoration, "none", `the summary carries no underline at ${width}`);

      await page.screenshot({ path: path.join(SHOTS, `sources-${width}-closed.png`), fullPage: true });

      await page.click("[data-sources] > summary");
      const open = await page.evaluate(PROBE);
      assert.equal(open.open, true, `clicking the line opens it at ${width}`);
      assert.equal(open.rows.length, 5, `every page and every search is listed at ${width}`);

      const text = open.rows.map((row) => row.text).join(" | ");
      for (const want of [
        "acehardware.com", "Hex bolts, 1/4 in. to 1/2 in.", "fetched",
        "fastenal.com", "Grade 5 hex cap screws in bulk packs", "through TinyFish",
        "boltdepot.com", "in Titan's browser",
        "1/4-20 hex bolt 25 pack in stock", "grade 5 bolt 25 count near me",
      ]) assert.ok(text.includes(want), `the open list says ${want} at ${width}, got ${text}`);
      // A page with no name is its address and its route, and nothing invented in between.
      const noTitle = open.rows.find((row) => row.text.includes("boltdepot.com"));
      assert.equal(noTitle.text.replace(/[\s\u00b7]+/g, " ").trim(), "boltdepot.com in Titan's browser",
        `a page with no title says only its address and its route at ${width}`);

      for (const row of open.rows) {
        assert.ok(row.right <= open.block.right + 1,
          `"${row.text.slice(0, 40)}" stays inside the column at ${width}: ${row.right} vs ${open.block.right}`);
        assertNotRed(row.color, `a source row at ${width}`);
      }
      assert.deepEqual([...new Set(open.decorations)], ["none"], `nothing inside the line is underlined at ${width}`);
      assert.ok(open.blockScroll.scrollWidth <= open.blockScroll.clientWidth + 1,
        `the open list does not widen the message column at ${width}: ${JSON.stringify(open.blockScroll)}`);
      assert.ok(open.docScroll.scrollWidth <= open.docScroll.clientWidth + 1,
        `the page does not scroll sideways at ${width}: ${JSON.stringify(open.docScroll)}`);

      const shot = path.join(SHOTS, `sources-${width}-open.png`);
      await page.screenshot({ path: shot, fullPage: true });
      shots.push(shot);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
  console.info(`[sources] screenshots: ${shots.join(" ")}`);
});

test("a reply that reached nothing draws no line at all", async (t) => {
  const playwright = PLAYWRIGHT_CANDIDATES.find((one) => existsSync(one));
  if (!existsSync(CHROME) || playwright == null) {
    t.skip("Chrome or playwright-core is absent; the render leg is skipped");
    return;
  }
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const from = app.indexOf("  const SOURCE_ROUTE_WORDS = {");
  const lineStart = app.indexOf("  function sourcesLineMarkup(message) {");
  const renderer = app.slice(from, app.indexOf("\n  }\n", lineStart) + 4);
  // Run in node rather than a browser: this is about the function returning nothing, and a fixture
  // that painted an empty string would prove the same thing more slowly.
  const markup = new Function("escapeHtml", `${renderer}\nreturn sourcesLineMarkup;`)(
    (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
  assert.equal(markup({ id: "m1" }), "", "a reply with no record draws nothing");
  assert.equal(markup({ id: "m1", sources: null }), "", "a null record draws nothing");
  assert.equal(markup({ id: "m1", sources: { pages: [], searches: [], pageCount: 0, searchCount: 0 } }), "",
    "a record that counted nothing draws nothing");
  // One of each, so the words are singular. This is the reply to a single-source question.
  const one = markup({
    id: "m1",
    sources: { pages: [{ kind: "page", domain: "example.com", route: "fetch" }], searches: [{ kind: "search", query: "q", tool: "WebSearch" }], pageCount: 1, searchCount: 1 },
  });
  assert.match(one, /Sources: 1 page, 1 search</, "one of each is singular");
  // Pages only, searches only: the side that counted nothing is left unsaid rather than said as 0.
  const pagesOnly = markup({ id: "m1", sources: { pages: [{ kind: "page", domain: "example.com", route: "fetch" }], searches: [], pageCount: 4, searchCount: 0 } });
  assert.match(pagesOnly, /Sources: 4 pages</, "a turn that ran no search does not say 0 searches");
  assert.ok(!pagesOnly.includes("0 search"), "nothing counted is nothing said");
});
