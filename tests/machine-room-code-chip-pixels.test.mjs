// CONSOLE-5, the honest form of "nothing else in the renderer changed".
//
// Jason, 2026-09-10, pointing at the original's transcript: a bot writes ids, emails, channels,
// hostnames and whole draft lines in backticks and each span is painted as a small chip that stands
// out from the prose and copies clean. This wave paints that chip. The risk is not that the chip
// looks wrong -- a golden-string test catches that. The risk is that a linkifier or a fenced-code
// handler creeps into the same renderer while it is open, because both are obvious and neither was
// asked for. A golden-string test would not notice: it only reads the strings it was told to read.
//
// So this suite renders ONE fixture transcript twice in the same browser, in the same viewport,
// over the shipped stylesheets: once through the renderer as it stood at b1f9afa (the tip this wave
// started from, frozen below) and once through the working tree's. Every element that is not a code
// chip -- every p, li, ul, ol, strong, em and heading -- must land on the same pixel. If a
// linkifier appears, the paragraph holding the bare URL grows an <a> and its children move, and
// this fails. If fenced code starts being handled, the three ``` paragraphs collapse into a block
// and the whole column shifts, and this fails.
//
// It is SKIPPED, with a sentence naming what it tried, when Chrome or playwright-core is absent --
// the resolver pattern tests/machine-room-voice.test.mjs:542-548 already uses.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

// The renderer as it shipped at b1f9afa, copied verbatim, the commit this wave branched from. It is
// frozen on purpose rather than read back out of git: a baseline that is derived from the file
// under test would grow whatever the file grew, which is exactly the drift this suite exists to
// catch. If this ever needs to move, it moves in a commit that says why.
const BASELINE_RENDERER = `
  function inlineMarkup(line) {
    return escapeHtml(line)
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/(^|[\\s(])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
  }

  function paragraphMarkup(text) {
    const lines = String(text || "").split("\\n");
    let html = "";
    let list = null;
    const closeList = () => { if (list) { html += \`</\${list}>\`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = /^\\s*[-*+]\\s+(.*)$/.exec(line);
      const numbered = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
      const heading = /^\\s{0,3}(#{1,4})\\s+(.*)$/.exec(line);
      if (bullet) {
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += \`<li>\${inlineMarkup(bullet[1])}</li>\`;
      } else if (numbered) {
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += \`<li>\${inlineMarkup(numbered[1])}</li>\`;
      } else if (heading) {
        closeList();
        html += \`<p class="message-heading"><strong>\${inlineMarkup(heading[2])}</strong></p>\`;
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        html += \`<p>\${inlineMarkup(line)}</p>\`;
      }
    }
    closeList();
    return html;
  }
`;

// The chip rules as they shipped at b1f9afa, copied verbatim from backgrounds.css:166-174, and
// served ONLY to the baseline page. Without them the "before" render would show a bare <code> with
// no styling at all -- because this wave deleted those rules -- and the comparison would be
// measuring a stylesheet that never existed instead of the renderer.
const BASELINE_CHIP_CSS = `
.message-bubble code {
  padding: 1px 5px;
  border-radius: 5px;
  font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255, 255, 255, 0.10);
}
[data-theme="mist"] .message-bubble code { background: rgba(30, 39, 43, 0.09); }
`;

// Everything the brief asks the fixture to hold, plus the two shapes nobody asked to be handled --
// the bare URL and the markdown link -- so a creeping linkifier has something to move.
const FIXTURE_TEXT = [
  "Chief alert is in `#titan-alerts`, the host is `titan-box-01`, and anything with a paper trail goes out from `titan@myagents.email`.",
  "",
  "## What I did",
  "- read the settings file",
  "- posted the summary",
  "",
  "1. first step",
  "2. second step",
  "",
  "Docs at https://titanium.bot/docs and see [the guide](https://titanium.bot/guide). **Bold** and *italic* still read the way they always did.",
  "",
  "The draft I would send: `Thanks for the heads up. I pulled the overnight sweep and three hosts are out of policy; the summary is with you before nine.`",
  "",
  "Here is the command:",
  "```",
  "docker ps --filter label=com.titanbot.role=box",
  "```",
].join("\n");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

/**
 * The console's own files, served flat, so the stylesheets load exactly as the browser loads them
 * and every relative url() inside them resolves. Plus one route the console does not have: the
 * fixture page, which takes the renderer to use as a query parameter. No adapter, no gateway, no
 * re-render loop -- the nodes are painted once and stay where they are put, which is what makes a
 * rect comparison mean anything.
 */
function serveFixture(rendererSource) {
  const root = path.join(repoRoot, "ui/machine-room");
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/fixture") {
      const base = url.searchParams.get("v") === "base";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(fixtureHtml(base ? BASELINE_RENDERER : rendererSource, base ? BASELINE_CHIP_CSS : ""));
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

function fixtureHtml(renderer, extraCss) {
  return `<!doctype html><html data-theme="night"><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/motion.css">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/backgrounds.css">
<style>body{margin:0;padding:18px;background:#0d1117}#transcript{max-width:760px}
/* A message row arrives on a scale-and-fade. Measured mid-flight the whole bubble reads about
   0.995 of itself, which drifts every rect in it -- the first run of this suite failed on exactly
   that, x and width and height all off by the same ratio. Geometry is only comparable once the
   motion is over, so here there is none. */
*, *::before, *::after { animation: none !important; transition: none !important; }
${extraCss}</style></head>
<body><main class="transcript" id="transcript"></main><script>
const escapeHtml = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
${renderer}
document.getElementById("transcript").innerHTML =
  '<article class="message-row"><div class="message-block"><div class="message-bubble">'
  + paragraphMarkup(${JSON.stringify(FIXTURE_TEXT)}) + '</div></div></article>';
window.__fixtureReady = true;
</script></body></html>`;
}

// Everything that is NOT a chip, in document order, with the geometry rounded the way a person sees
// it. Sub-pixel noise is not what this suite is about; a moved line is.
const PROBE = `(() => {
  const bubble = document.querySelector(".message-bubble");
  const round = (n) => Math.round(n * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }; };
  const prose = [...bubble.querySelectorAll("p, ul, ol, li, strong, em, a")].map((el) => ({
    tag: el.tagName, cls: el.className, text: el.textContent, ...box(el),
  }));
  const chips = [...bubble.querySelectorAll("code")].map((el) => {
    const s = getComputedStyle(el);
    return { text: el.textContent, cls: el.className, role: el.getAttribute("role"),
      tabindex: el.getAttribute("tabindex"), color: s.color, background: s.backgroundColor,
      borderWidth: s.borderTopWidth, overflowWrap: s.overflowWrap, cursor: s.cursor, ...box(el) };
  });
  return { prose, chips, bubble: box(bubble), inner: round(bubble.clientWidth) };
})()`;

test("CONSOLE-5 in a real browser: the chip is the only thing that moved", async (t) => {
  const playwright = PLAYWRIGHT_CANDIDATES.find((one) => existsSync(one));
  if (!existsSync(CHROME) || playwright == null) {
    t.skip(`tried Chrome at ${CHROME} and playwright-core at ${PLAYWRIGHT_CANDIDATES.join(", ")}; `
      + "set GROK_BOT_CHROME / GROK_BOT_PLAYWRIGHT to run the pixel leg");
    return;
  }
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const from = app.indexOf("  function inlineMarkup(line) {");
  const paraStart = app.indexOf("  function paragraphMarkup(text) {");
  const to = app.indexOf("\n  }\n", paraStart) + 4;
  assert.ok(from > 0 && paraStart > from, "the renderer must still be findable in app.js");
  const server = serveFixture(app.slice(from, to));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(playwright);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 900, height: 1400 },
      reducedMotion: "reduce",
      // Every gate this repo runs says who it is.
      userAgent: "titanbot-gate/machine-room-code-chip-pixels",
    });
    const read = async (which) => {
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/fixture?v=${which}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => window.__fixtureReady === true, null, { timeout: 15000 });
      const shot = await page.evaluate(PROBE);
      assert.deepEqual(errors, [], `${which} rendered without a page error`);
      await page.close();
      return shot;
    };
    const before = await read("base");
    const after = await read("now");

    // 1. The prose did not move. Node for node, in document order, to the pixel.
    assert.equal(after.prose.length, before.prose.length,
      "the renderer produced the same non-chip elements: a new <a> or a collapsed fence changes this count");
    for (const [i, was] of before.prose.entries()) {
      const now = after.prose[i];
      assert.equal(now.tag, was.tag, `element ${i} is still a ${was.tag}`);
      assert.equal(now.text, was.text, `element ${i} still says the same thing`);
      assert.deepEqual({ x: now.x, y: now.y, w: now.w, h: now.h }, { x: was.x, y: was.y, w: was.w, h: was.h },
        `element ${i} (${was.tag} "${was.text.slice(0, 40)}") did not move`);
    }
    assert.deepEqual(after.bubble, before.bubble, "the bubble itself is the same size in the same place");

    // 2. Neither the bare URL nor the markdown link grew a link, and the fence stayed three
    //    paragraphs. Named rather than implied, so the failure says which one crept in.
    assert.ok(!before.prose.some((one) => one.tag === "A"), "the baseline had no anchor to compare against");
    assert.ok(!after.prose.some((one) => one.tag === "A"),
      "no linkifier crept in: a bare URL and a markdown link both stay plain text, as they did before");
    assert.equal(after.prose.filter((one) => one.text === "```").length, 2,
      "fenced code is still two literal paragraphs and a line between them, not a block this wave invented");

    // 3. The chips are the ONLY nodes that changed, and they changed into the thing Jason drew.
    assert.equal(after.chips.length, before.chips.length, "the same spans are code spans");
    assert.equal(after.chips.length, 4, "three short ones and the long draft line");
    for (const [i, was] of before.chips.entries()) {
      const now = after.chips[i];
      assert.equal(now.text, was.text, `chip ${i} carries the same text`);
      assert.notEqual(now.color, was.color, `chip ${i} is not the colour it was`);
      assert.equal(now.cls, "code-chip", `chip ${i} carries the class`);
      assert.equal(now.role, "button", `chip ${i} announces itself`);
      assert.equal(now.tabindex, "0", `chip ${i} can be reached from a keyboard`);
      assert.equal(now.cursor, "pointer", `chip ${i} looks like the thing it is`);
      assert.notEqual(now.borderWidth, "0px", `chip ${i} has the hairline the original had`);
      assert.equal(now.overflowWrap, "anywhere", `chip ${i} may break anywhere`);
    }
    // The console's own muted cyan, not white and not the error colour: --danger-500 is #ff6f72, and
    // CONSOLE-5b took the chip off the red-pink #ff6b6b that sat one shade from it, because an
    // identifier in the failure colour reads as a failed turn and because that red stood out harsh.
    assert.equal(after.chips[0].color, "rgb(143, 217, 230)", "the chip is the muted cyan, not body white");
    assert.notEqual(after.chips[0].color, "rgb(255, 111, 114)", "and never --danger-500, which reads as a failed turn");

    // 4. The long chip wraps INSIDE the bubble instead of running out past its edge.
    const long = after.chips.find((one) => one.text.length > 100);
    assert.ok(long, "the fixture holds a whole draft line as one chip");
    assert.ok(long.w <= after.inner + 1, `the long chip stays inside the bubble: ${long.w} of ${after.inner}`);
    assert.ok(long.h > after.chips[0].h * 1.5, "and it wrapped onto more than one line rather than being clipped");
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
