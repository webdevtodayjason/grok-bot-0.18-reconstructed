// Agents answer in markdown. The first renderer escaped and split on newlines, so a briefing
// arrived as literal asterisks; the second made a list only when EVERY line in a block was a
// bullet, which is not how anyone writes. Both bugs are cheap to reintroduce, and the escape-first
// ordering is the only thing standing between an agent's text and injected markup.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Lift the two functions straight out of the shipped file so the test cannot drift from it.
async function loadRenderer() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const inlineStart = source.indexOf("  function inlineMarkup(line) {");
  const paraStart = source.indexOf("  function paragraphMarkup(text) {");
  const paraEnd = source.indexOf("\n  }\n", paraStart) + 4;
  assert.ok(inlineStart > 0 && paraStart > inlineStart, "renderer functions must be findable in app.js");
  const body = source.slice(inlineStart, paraEnd);
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return new Function("escapeHtml", `${body}\nreturn { inlineMarkup, paragraphMarkup };`)(escapeHtml);
}

const { paragraphMarkup } = await loadRenderer();

test("a lead sentence followed by bullets makes a real list", () => {
  // The exact shape an agent replies in, and the one the block-based pass got wrong.
  const html = paragraphMarkup("**ready** `ok`\n- one\n- two");
  assert.match(html, /<strong>ready<\/strong>/);
  // CONSOLE-5 moved the <code> to a chip. The assertion is the same one it always was -- the
  // backticked span survives the escape and comes out as a code element carrying its own text.
  assert.match(html, /<code class="code-chip"[^>]*>ok<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("a numbered list is an ordered list", () => {
  const html = paragraphMarkup("Steps:\n1. first\n2. second");
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("a list closes when prose resumes", () => {
  const html = paragraphMarkup("- one\nback to prose");
  assert.match(html, /<\/ul><p>back to prose<\/p>/);
});

test("headings do not become page-scale h1s inside a chat bubble", () => {
  const html = paragraphMarkup("## Geopolitics");
  assert.match(html, /message-heading/);
  assert.doesNotMatch(html, /<h1|<h2/);
});

test("markup an agent writes is escaped, on either side of a bullet", () => {
  const html = paragraphMarkup("<img src=x onerror=alert(1)>\n- <script>bad()</script>");
  assert.doesNotMatch(html, /<img|<script/, "no raw tag may survive");
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
});

test("escaping happens before the inline pass, so markup cannot be smuggled through it", () => {
  // If the order were reversed, the backticks would wrap a live tag instead of an escaped one.
  const html = paragraphMarkup("`<b>not bold</b>`");
  assert.match(html, /<code class="code-chip"[^>]*>&lt;b&gt;not bold&lt;\/b&gt;<\/code>/);
});

test("empty input renders nothing rather than an empty paragraph", () => {
  assert.equal(paragraphMarkup(""), "");
});

// ------------------------------------------------------------------ CONSOLE-5, the code chip
//
// Jason, 2026-09-10, on the original's transcript: a bot writes ids, emails, channels and whole
// draft lines in backticks and each one is painted as a small chip that stands out from the prose
// and copies clean. MEASURED here before the change, on grok-bot-local-vm in Chrome at 1440x1000 on
// a live agent reply: rgba(255,255,255,0.94) on rgba(255,255,255,0.10), no border. Body white on a
// white wash, which is a span that does not stand out from the sentence holding it.

test("a backticked span is a chip, and the chip is reachable from a keyboard", () => {
  const html = paragraphMarkup("Alerts land in `#titan-alerts`.");
  assert.match(html, /class="code-chip"/, "the class the stylesheet hangs on");
  assert.match(html, /tabindex="0"/, "a chip can be focused");
  assert.match(html, /role="button"/, "and it announces itself as something to press");
  assert.match(html, /aria-label="Copy this"/, "with what pressing it does");
});

test("a chip is still escaped inside itself, which is the only guard on an agent's text", () => {
  // The escape-first ordering matters more now, not less: the chip carries attributes, so a capture
  // that could close the tag would be closing a tag with a role on it.
  const html = paragraphMarkup('`<b>x</b>` and `a"b`');
  assert.doesNotMatch(html, /<b>/, "no raw tag survives inside a chip");
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /a&quot;b/, "a quote in the text cannot break out of the attribute list");
});

test("a chip with nothing to break on is allowed to wrap rather than run past the bubble", async () => {
  // A rule, not a rendering: the pixel suite proves the geometry in a browser. This is the cheap
  // guard that the declaration cannot be dropped in a tidy-up.
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  const block = /code\.code-chip\s*\{[^}]*\}/.exec(css);
  assert.ok(block, "styles.css owns the chip");
  assert.match(block[0], /overflow-wrap:\s*anywhere/, "a 60-character id wraps inside the bubble");
  assert.match(block[0], /cursor:\s*pointer/, "and it looks like the thing it is");
  assert.ok(!/--danger-500/.test(block[0]),
    "the chip is never the error colour: every identifier in it would read as a failed turn");
});

test("nothing else paints a code element any more", async () => {
  // Two rules used to argue over this element, and the later stylesheet won by accident. Both are
  // gone; if one comes back the chip silently loses its colour in the browser and nowhere else.
  for (const file of ["ui/machine-room/backgrounds.css", "ui/machine-room/files-viewer.css"]) {
    const css = await readFile(path.join(repoRoot, file), "utf8");
    assert.ok(!/^[^\n{]*\bcode\s*\{/m.test(css), `${file} no longer styles a bare code element`);
  }
});
