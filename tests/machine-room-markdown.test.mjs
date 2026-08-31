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
  assert.match(html, /<code>ok<\/code>/);
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
  assert.match(html, /<code>&lt;b&gt;not bold&lt;\/b&gt;<\/code>/);
});

test("empty input renders nothing rather than an empty paragraph", () => {
  assert.equal(paragraphMarkup(""), "");
});
