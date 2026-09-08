// BROWSER-1. What the driver reads off a page, and what it decides about it, on fixture HTML.
//
// These are the two functions a person feels: the text is what Titan reports back, and the two
// flags are what turn "I could not read it" into "the site wants you signed in" or "the site put up
// a challenge". They run over document.documentElement.outerHTML in the box, so the fixtures here
// are rendered DOM, not server response bodies, which is why an SPA fixture has an empty root div
// and arrives with its text in innerText instead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TEXT_CAP,
  analyzePage,
  decodeEntities,
  detectBlocked,
  detectNeedsLogin,
  extractReadableText,
  parseHtml,
} from "../runtime/browser-driver/page-text.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, "fixtures/browser-driver", name), "utf8");

test("the article's own words come back, and the furniture around it does not", () => {
  const { text, source, truncated } = extractReadableText(fixture("article.html"));

  assert.equal(source, "main");
  assert.equal(truncated, false);
  assert.match(text, /The power went out at 4am/);
  assert.match(text, /A backup nobody has restored is a rumour/);
  assert.match(text, /- Nine nodes, three sites, one schedule\./, "list items keep their shape");

  for (const furniture of ["Services", "Pricing", "Contact", "All rights reserved", "Ten things about tape"]) {
    assert.ok(!text.includes(furniture), `"${furniture}" is nav, footer or sidebar and must not be in the page text`);
  }
  assert.ok(!text.includes("tracking beacon"), "script bodies are never page text");
  assert.ok(!text.includes("display:none"), "style bodies are never page text");
});

test("a block of prose beats a longer block of links", () => {
  const { text } = extractReadableText(fixture("link-farm.html"));
  assert.match(text, /A directory page is mostly links/);
  assert.ok(!text.includes("Managed backup for small offices"), "the link list lost on link density, as it should");
});

test("entities decode, comments vanish, and a line break is a line", () => {
  const { text } = extractReadableText(fixture("entities.html"));
  assert.match(text, /Tom & Jerry's rule/);
  assert.match(text, /costs £0 to take/);
  assert.match(text, /5 < 6 < 7/);
  assert.match(text, /"measure it on the machine you will run it on"/);
  assert.match(text, /<script>alert\(1\)<\/script> is a string here/, "escaped markup stays text");
  assert.match(text, /Line one\nline two\nline three/);
  assert.ok(!text.includes("a comment that must not be read"), "HTML comments are not page text");
});

test("decodeEntities leaves anything it does not know alone", () => {
  assert.equal(decodeEntities("a &amp; b &notareal; c &#65; &#x42;"), "a & b &notareal; c A B");
});

test("a page with nothing in its markup falls back to what the browser rendered", () => {
  const shell = fixture("spa-shell.html");
  const bare = extractReadableText(shell);
  assert.equal(bare.text.length, 0, "there is genuinely nothing in the markup");

  const rendered = extractReadableText(shell, { innerText: "Agents\n\nTitan is running. Three jobs finished this morning." });
  assert.equal(rendered.source, "innerText");
  assert.match(rendered.text, /Three jobs finished this morning/);
});

test("the text is capped at 40k and cut on a word, not mid-word", () => {
  const sentence = "The backup mesh writes every snapshot to two other nodes on a fifteen minute schedule. ";
  const html = `<html><body><article>${`<p>${sentence.repeat(40)}</p>`.repeat(30)}</article></body></html>`;
  const { text, truncated, characters } = extractReadableText(html);

  assert.equal(truncated, true);
  assert.ok(text.length <= TEXT_CAP, `${text.length} characters is within the ${TEXT_CAP} cap`);
  assert.ok(text.length > TEXT_CAP - 400, "the cut is at the cap, not far short of it");
  assert.equal(characters, text.length);
  assert.equal(text.trimEnd(), text, "no trailing space where the cut landed");
  assert.ok(text.endsWith("schedule.") || /\w$/.test(text), "the cut lands after a whole word, not inside one");

  const smaller = extractReadableText(html, { cap: 1200 });
  assert.ok(smaller.text.length <= 1200, "the cap is a parameter, not a constant the caller cannot reach");
});

test("a sign-in page reads as one, in words a person would use", () => {
  const html = fixture("login.html");
  const decision = detectNeedsLogin({ html, url: "https://console.example.com/login", title: "Sign in - Titanium Console" });
  assert.equal(decision.needsLogin, true);
  assert.match(decision.reason, /sign-in form asking for a password/);
  assert.ok(!/[A-Z]{3,}|selector|DOM|querySelector/.test(decision.reason), "the reason is plain words");
});

test("a page that only says it wants you signed in also reads as one", () => {
  const html = fixture("soft-wall.html");
  const decision = detectNeedsLogin({ html, url: "https://example.com/quarterly", title: "Quarterly numbers - Members" });
  assert.equal(decision.needsLogin, true);
  assert.match(decision.reason, /needs you signed in/);
});

test("an ordinary article does not read as a login, even with a sign-in link on it", () => {
  const decision = detectNeedsLogin({
    html: fixture("article.html"),
    url: "https://example.com/posts/backup-mesh",
    title: "How the backup mesh survived the outage",
  });
  assert.equal(decision.needsLogin, false);
});

test("a long page behind a password field is not called a login page", () => {
  // A search field on a very long page: a password input alone must not be enough.
  const body = "<p>Everything about the outage, at length. </p>".repeat(400);
  const html = `<html><body><main>${body}<form><input type="password" name="pw"></form></main></body></html>`;
  const decision = detectNeedsLogin({ html, url: "https://example.com/report", title: "The outage report" });
  assert.equal(decision.needsLogin, false, "a whole page of reading is not a login wall");
});

test("a challenge page is called a challenge, by signature and by wording", () => {
  const html = fixture("challenge.html");
  const { text } = extractReadableText(html);

  const bySignature = detectBlocked({ url: "https://shop.example.com/cart", title: "Just a moment...", text: "", status: 200 });
  assert.equal(bySignature.blocked, true);
  assert.equal(bySignature.family, "cloudflare_challenge");

  const byWording = detectBlocked({ url: "https://shop.example.com/cart", title: "Checking", text, status: 200 });
  assert.equal(byWording.blocked, true);
  assert.match(byWording.reason, /human check/);
});

test("a refusal status is a block whatever the page says", () => {
  assert.equal(detectBlocked({ url: "https://example.com/", title: "", text: "", status: 403 }).blocked, true);
  assert.equal(detectBlocked({ url: "https://example.com/", title: "", text: "", status: 429 }).family, "http_429");
  assert.equal(detectBlocked({ url: "https://example.com/", title: "Example Domain", text: "hello", status: 200 }).blocked, false);
});

test("the block signatures cover the families the audit ledger already classifies", () => {
  const cases = [
    ["https://www.google.com/sorry/index", "", "google_sorry"],
    ["https://accounts.google.com/signin/rejected", "", "google_signin_rejected"],
    ["https://www.linkedin.com/checkpoint/challenge/verify", "", "linkedin_checkpoint"],
    ["https://geo.captcha-delivery.com/captcha/", "", "datadome"],
    ["https://example.com/px/captcha", "", "perimeterx"],
    ["https://example.com/", "Pardon Our Interruption", "distil"],
    ["https://example.com/", "Vercel Security Checkpoint", "vercel_checkpoint"],
    ["https://example.com/_Incapsula_Resource?x=1", "", "imperva"],
  ];
  for (const [url, title, family] of cases) {
    const decision = detectBlocked({ url, title, text: "", status: 200 });
    assert.equal(decision.blocked, true, `${url} ${title} is a block`);
    assert.equal(decision.family, family);
  }
});

test("a bad url does not throw, it just is not a known challenge", () => {
  assert.equal(detectBlocked({ url: "not a url at all", title: "", text: "", status: 200 }).blocked, false);
  assert.doesNotThrow(() => parseHtml("<div><p>unclosed everything"));
});

test("analyzePage is the one shape the tool and the CLI hand back", () => {
  const result = analyzePage({
    html: fixture("login.html"),
    innerText: "",
    title: "Sign in - Titanium Console",
    url: "https://console.example.com/login",
    status: 200,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "blocked", "blockedFamily", "blockedReason", "needsLogin", "needsLoginReason", "text", "textSource", "textTruncated",
  ]);
  assert.equal(result.needsLogin, true);
  assert.equal(result.blocked, false);
  assert.equal(typeof result.text, "string");
  assert.equal(typeof result.textTruncated, "boolean");
});
