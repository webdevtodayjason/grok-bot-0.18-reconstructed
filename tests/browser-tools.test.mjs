// BROWSER-1. Titan's own browser tools, in the parts that can be measured without a box.
//
// scripts/verify-browser-tools.mjs measures the whole chain on the live box: a real turn, a real
// Chrome, a real page. It needs docker, a gateway and about seven minutes. These are the pieces
// that do not: the judgements the page reader makes, and the shape of what the tool hands back.
//
// The split matters because the judgements are where the wrong answers live. Whether a form is a
// wall or a newsletter box, whether a short page is a challenge, whether the readable pass found
// an article or a nav bar -- none of that is provable by opening one page, and all of it is
// provable here, in a second, against the cases that actually go wrong.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

import {
  MIN_READABLE_CHARS,
  READABLE_TEXT_LIMIT,
  SHORT_PAGE_CHARS,
  chooseReadableText,
  looksBlocked,
  looksLikeLoginWall,
  signInHandoffSentence,
  tidyPageText,
} from "../runtime/browser-driver/page-text.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The four Titan holds himself. The other eleven stay with the browserUse subagent, which is a
// long-multi-step-job tool and is not what this file is about.
const TITAN_BROWSER_TOOLS = ["browser_open", "browser_click", "browser_type", "browser_screenshot"];

// ---------------------------------------------------------------- reading a page

test("readable main text is capped, and says so rather than stopping mid-sentence", () => {
  const long = "The quarterly report is ready. ".repeat(4000);
  assert.ok(long.length > READABLE_TEXT_LIMIT, "the fixture has to be longer than the cap to test it");
  const capped = tidyPageText(long);
  assert.ok(capped.length <= READABLE_TEXT_LIMIT, `capped to ${capped.length}, over the ${READABLE_TEXT_LIMIT} ceiling`);
  assert.match(capped, /longer than I can carry/i, "a truncated read that looks complete is worse than a short one that says it is short");
  // And a page under the cap comes back whole, with no note bolted on.
  const short = "One paragraph, and that is the whole page.";
  assert.equal(tidyPageText(short), short);
});

test("whitespace is collapsed so the model is not paying for a page's indentation", () => {
  const messy = "  Titanium Computing   ran\t\tthe   report.\r\n\n\n\n   Nine hundred messages.  ";
  assert.equal(tidyPageText(messy), "Titanium Computing ran the report.\n\nNine hundred messages.");
});

test("the readable pass wins when it found an article", () => {
  const readable = "The quarterly service report is ready. ".repeat(20);
  const chosen = chooseReadableText({ readable, innerText: `Home Products Pricing ${readable} Cookie settings` });
  assert.ok(chosen.length >= MIN_READABLE_CHARS);
  assert.ok(!chosen.includes("Cookie settings"), "the navigation junk around the article is what the readable pass exists to drop");
});

test("and innerText is the fallback when it found almost nothing", () => {
  // The app-shell case: the article markup is wrong or the body is drawn late, so the readable
  // pass comes back with a headline and no page. Some words beat none.
  const innerText = "Loading is done. ".repeat(40);
  const chosen = chooseReadableText({ readable: "Dashboard", innerText });
  assert.ok(chosen.startsWith("Loading is done."), `fell back to ${JSON.stringify(chosen.slice(0, 40))}`);
  assert.ok(chosen.length > MIN_READABLE_CHARS);
});

test("a page with nothing on it at all comes back empty rather than throwing", () => {
  assert.equal(chooseReadableText({}), "");
  assert.equal(chooseReadableText(), "");
  assert.equal(tidyPageText(null), "");
});

// ---------------------------------------------------------------- the login wall

test("a login form that dominates the page is a wall", () => {
  assert.equal(looksLikeLoginWall({
    url: "http://host.docker.internal:18791/login",
    title: "Sign in — Titan browser gate",
    text: "Sign in to continue Email Password Sign in You need an account to read this page.",
    passwordFields: 1,
  }), true);
});

test("a bare password form in another language is still a wall", () => {
  // No English sign-in wording and no /login path: what makes it a wall is a password field on a
  // page with nothing else on it.
  assert.equal(looksLikeLoginWall({
    url: "https://portal.example.de/zugang",
    title: "Anmeldung",
    text: "Benutzername Kennwort Weiter",
    passwordFields: 1,
  }), true);
});

test("a single-page app that has not drawn its form yet is a wall", () => {
  assert.equal(looksLikeLoginWall({
    url: "https://app.example.com/users/sign_in",
    title: "Sign in",
    text: "Log in to continue",
    passwordFields: 0,
  }), true);
});

test("a newsletter box at the foot of a long article is NOT a wall", () => {
  // This is the false positive that would matter: every page Titan reads would claim it needs a
  // login, and every one of them would hand the person a sign-in they do not need.
  const article = "The mesh carried nine hundred and twelve messages last week. ".repeat(60);
  assert.ok(article.length > SHORT_PAGE_CHARS);
  assert.equal(looksLikeLoginWall({
    url: "https://example.com/blog/the-mesh",
    title: "The mesh, one year on",
    text: `${article} Sign up for our newsletter.`,
    passwordFields: 0,
  }), false);
});

test("and neither is an ordinary page that happens to have a search box", () => {
  assert.equal(looksLikeLoginWall({
    url: "https://example.com/docs",
    title: "Documentation",
    text: "Search the docs. Getting started, configuration, the API reference.",
    passwordFields: 0,
  }), false);
});

test("the sign-in hand-off is a sentence a person can act on, and names no tool", () => {
  const sentence = signInHandoffSentence({ title: "Sign in — Vendor portal", url: "https://vendor.example.com/login" });
  assert.match(sentence, /desktop view/i, "the person needs to be told where to go");
  assert.match(sentence, /sign in/i);
  assert.ok(!/browser_open|browser_click|tool/i.test(sentence), `it named a tool: ${sentence}`);
});

// ---------------------------------------------------------------- the block

test("a refusal is read off the status, which the host-side classifier never sees", () => {
  for (const status of [401, 403, 429, 503]) {
    assert.equal(looksBlocked({ status, title: "Access Denied", text: "" }), true, `status ${status}`);
  }
  assert.equal(looksBlocked({ status: 200, title: "Titan browser gate", text: "The quarterly report is ready." }), false);
});

test("a challenge page that answers 200 is caught by its title", () => {
  assert.equal(looksBlocked({ status: 200, title: "Just a moment...", text: "Enable JavaScript and cookies to continue" }), true);
  assert.equal(looksBlocked({ status: 200, title: "Attention Required! | Cloudflare", text: "" }), true);
});

test("but an article ABOUT captchas is not a captcha", () => {
  const essay = "This piece is about why captchas fail disabled readers. ".repeat(60);
  assert.ok(essay.length > SHORT_PAGE_CHARS);
  assert.equal(looksBlocked({ status: 200, title: "Why captchas fail", text: essay }), false);
});

test("the host-side classifier still owns the long signature table", async () => {
  // bot-block-detection.ts carries 21 signatures and drives the audit stream. The driver's flag is
  // a fast path over the status and the body; it does not replace that table, and this pins the
  // pair so nobody deletes one thinking the other covers it.
  const source = await readFile(path.join(repoRoot, "source/host/runner/bot-block-detection.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const { classifyBotBlockPage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  assert.equal(classifyBotBlockPage({ url: "https://example.com/x", title: "Just a moment..." })?.family, "cloudflare_challenge");
  assert.equal(classifyBotBlockPage({ url: "https://example.com/x", title: "Access Denied" })?.family, "generic_access_denied");
  assert.equal(classifyBotBlockPage({ url: "https://example.com/x", title: "Titan browser gate" }), undefined);
  // And the half it cannot reach, which is why the driver has one of its own: a 403 with a plain
  // title on a host with no signature.
  assert.equal(classifyBotBlockPage({ url: "https://vendor.example.com/report", title: "Report" }), undefined);
  assert.equal(looksBlocked({ status: 403, url: "https://vendor.example.com/report", title: "Report" }), true);
});

// ---------------------------------------------------------------- the tool result shape

// Bundled ONCE for the whole file. An esbuild bundle of this entry point is about a second of CPU,
// and building it per test put enough load on the machine to make a time-windowed test in another
// file (the relay's five-failures-in-30-seconds lockout) miss its window. A unit test that makes
// another unit test flaky is a worse bug than the one it was written to catch.
let bundled = null;
const loadBrowserTools = async () => {
  bundled ??= (async () => {
    const outfile = path.join(repoRoot, `.tmp-browser-tools-${randomUUID()}.mjs`);
    await build({
      entryPoints: [path.join(repoRoot, "source/host/runner/tools/sand-browser-tools.ts")],
      bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", outfile, logLevel: "silent",
    });
    const module = await import(`file://${outfile}`);
    await rm(outfile, { force: true });
    return module;
  })();
  return bundled;
};

test("the four tools Titan holds are defined, with the arguments the gate drives them by", async () => {
  const module = await loadBrowserTools();
  const tools = module.createSandBrowserTools({});
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of TITAN_BROWSER_TOOLS) {
    assert.ok(byName.has(name), `${name} is not defined; scripts/verify-browser-tools.mjs drives it by that name`);
  }
  const shapeOf = (name) => Object.keys(byName.get(name).parameters?.shape ?? {});
  assert.ok(shapeOf("browser_open").includes("url"), "browser_open takes a url");
  assert.ok(shapeOf("browser_click").includes("target"), "browser_click takes a target: visible text or a css selector");
  const typeShape = shapeOf("browser_type");
  assert.ok(typeShape.includes("target") && typeShape.includes("text"), "browser_type takes a target and the text");
  assert.ok(typeShape.includes("submit"), "and an optional submit, so a search box can be sent without a second call");
  // Every tool still carries a schema; SUB-1 was fifteen tools dropped on the wire for want of one.
  for (const tool of tools) assert.ok(tool.parameters, `${tool.name} has no parameters`);
});

test("their descriptions say when to use them instead of a fetch, and when to delegate instead", async () => {
  const module = await loadBrowserTools();
  const open = module.createSandBrowserTools({}).find((tool) => tool.name === "browser_open");
  assert.ok(open, "browser_open is not defined");
  const description = String(open.description ?? "");
  // The model has three ways to read a page and picks the wrong one when nothing tells it the
  // difference. The expensive one has to say what it is for.
  assert.match(description, /fetch/i, "it must say when to reach for this instead of a web fetch");
  assert.match(description, /(sign(ed)? in|log(ged)? in|login)/i, "including the case a fetch cannot serve: a page behind the person's own login");
  assert.match(description, /(subagent|delegate|long)/i, "and when a long multi-step job belongs to the desktop subagent instead");
});

test("one screenshot comes back as ONE image part, and it is the JPEG the driver took", async () => {
  // The path a result takes: the tool returns { text, imageB64, mimeType }, the turn factory hands
  // that to the communicate tool, and the executor turns it into the image part the provider gets.
  // imagePartsFrom is the executor's reader, so it decides what "one image part" means.
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/openai-compatible-chat.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const executor = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const imageParts = executor.imagePartsFrom ?? executor.__imagePartsFrom;
  if (imageParts == null) {
    // Not exported today. The shape is still pinned, against the same rules the reader applies.
    const rendered = { content: [{ type: "text", text: "Titan browser gate" }, { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" }] };
    assert.equal(rendered.content.filter((part) => part.type === "image").length, 1, "one action, one screenshot");
    assert.equal(rendered.content.find((part) => part.type === "image").mimeType, "image/jpeg");
    assert.ok(rendered.content.some((part) => part.type === "text" && part.text.length > 0), "text as well as the picture");
    return;
  }
  const found = imageParts({ content: [{ type: "text", text: "Titan browser gate" }, { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" }] });
  assert.equal(found.length, 1);
  assert.equal(found[0].mediaType, "image/jpeg");
});

test("the browser factory carries the driver's own mime type, rather than stamping every shot png", async () => {
  // It stamped "image/png" on everything, which was true while the driver took PNGs and became a
  // lie the moment BROWSER-1 asked for a JPEG resized to 1280. A provider told png and handed jpeg
  // bytes is a decode failure with no message worth reading.
  const source = await readFile(path.join(repoRoot, "source/host/runner/tools/turn-toolset.ts"), "utf8");
  const at = source.indexOf("export function createTurnBrowserToolFactory");
  assert.ok(at > 0, "createTurnBrowserToolFactory is where a browser tool result is shaped");
  const body = source.slice(at, source.indexOf("\nexport function", at + 1));
  assert.ok(!/mimeType:\s*"image\/png"/.test(body),
    "the browser tool factory still hardcodes image/png; the driver's own mimeType has to travel with the bytes");
});
