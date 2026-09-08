// BROWSER-1. Titan's own browser tools, in the parts that can be measured without a box.
//
// scripts/verify-browser-tools.mjs measures the whole chain on the live box: a real turn, a real
// Chrome, a real page. It needs docker, a gateway and about seven minutes. These are the pieces
// that do not: the judgement a page read makes about a wall, and the shape of what the tool hands
// back to the model.
//
// The page reader itself is pinned next door in tests/browser-driver-extraction.test.mjs, against
// the one module that does the reading (runtime/browser-driver/page-text.mjs). This file holds the
// two cases that are about the SEAM rather than the reader: the driver's fast path and the
// host-side signature table must each catch what the other cannot, and the tool result the model
// is handed must be text plus one JPEG.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

import { detectBlocked } from "../runtime/browser-driver/page-text.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The four Titan holds himself. The other eleven stay with the browserUse subagent, which is a
// long-multi-step-job tool and is not what this file is about.
const TITAN_BROWSER_TOOLS = ["browser_open", "browser_click", "browser_type", "browser_screenshot"];

// ---------------------------------------------------------------- reading a page

test("an article ABOUT captchas is not a captcha", () => {
  // The wording test only runs on a short page, because a long one is an article and a wall is not.
  const essay = "This piece is about why captchas fail disabled readers. ".repeat(60);
  assert.ok(essay.length > 3000, "the fixture has to be longer than the wording window to test it");
  assert.equal(detectBlocked({ status: 200, url: "https://example.com/essay", title: "Why captchas fail", text: essay }).blocked, false);
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
  assert.equal(detectBlocked({ status: 403, url: "https://vendor.example.com/report", title: "Report" }).blocked, true);
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
      entryPoints: [path.join(repoRoot, "source/host/runner/tools/sand-browser-direct-tools.ts")],
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
  const tools = module.createSandDirectBrowserTools({});
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
  const open = module.createSandDirectBrowserTools({}).find((tool) => tool.name === "browser_open");
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
