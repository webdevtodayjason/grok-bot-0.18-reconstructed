// BROWSER-1. Titan's own four browser tools, measured without a box.
//
// The box has always run a signed-in Chrome and the host has always had a driver for it, but the
// main agent was handed neither: the fifteen page-level browser_* tools were pushed only for a
// browserUse subagent, and that subagent sits behind a feature gate this deployment cannot turn
// on. So "read this page for me" had exactly one road, a web fetch, and when the fetch was refused
// the answer was "I can't".
//
// These cases pin the three things the tools promise the model, with a fake driver standing in for
// the box: the result of an open is text plus exactly ONE image, an open leaves one
// browser_navigation row in the audit ledger with the page's url and title, and a page that is
// walled or refused says so in words a person can be told.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = [];
const bundle = async (entry) => {
  const outfile = path.join(repoRoot, `.tmp-browser-direct-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, format: "esm", platform: "node", target: "node22", packages: "external",
    outfile, logLevel: "silent",
  });
  built.push(outfile);
  return import(`file://${outfile}`);
};
test.after(async () => {
  await Promise.all(built.map((file) => rm(file, { force: true })));
});

const tools = await bundle("source/host/runner/tools/sand-browser-direct-tools.ts");
const driverSource = await bundle("source/host/runner/tools/sand-browser-driver-source.ts");
const setting = await bundle("source/host/sand-box-setting.ts");
const MARKER = driverSource.SAND_BROWSER_RESULT_MARKER;

const SHOT = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/**
 * A driver that answers one canned response. Everything the real dependencies do against the box
 * is recorded instead: which shell command was built, which screenshot path was asked for, how
 * many times the shot was pulled back.
 */
function fakeDependencies(response, options = {}) {
  const calls = { shell: [], downloads: [], uploads: 0, navigations: [] };
  return {
    calls,
    dependencies: {
      resourceAccessor: { get: () => ({}) },
      getWindowIndex: async () => options.windowIndex ?? 10,
      getBoxId: () => "agent-under-test",
      getDefaultViewId: () => "agent-under-test",
      uploadFile: async () => { calls.uploads += 1; },
      downloadFile: async (_context, _boxId, boxPath) => {
        calls.downloads.push(boxPath);
        return SHOT;
      },
      executeShell: async (_context, input) => {
        calls.shell.push(input);
        return {
          case: "success",
          exitCode: 0,
          stdout: `some chatter on stdout\n${MARKER}${JSON.stringify(response)}\n`,
          stderr: "",
        };
      },
      recordNavigation: (row) => { calls.navigations.push(row); },
    },
  };
}

const byName = (list) => new Map(list.map((entry) => [entry.name, entry]));

/** The request the tool actually sent the box driver, decoded back out of the argv. */
function decodeRequest(shellInput) {
  const encoded = shellInput.command.split(" ").at(-1);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test("the four tools are the ones Titan is offered, and each carries a model-facing schema", () => {
  const list = tools.createSandDirectBrowserTools(fakeDependencies({ ok: true }).dependencies);
  assert.deepEqual(list.map((entry) => entry.name), [
    "browser_open", "browser_click", "browser_type", "browser_screenshot",
  ]);
  for (const entry of list) {
    assert.ok(entry.parameters, `${entry.name} has no parameters`);
    const shape = Object.keys(entry.parameters.shape ?? {});
    for (const name of entry.schema.required ?? []) {
      assert.ok(shape.includes(name), `${entry.name}: required argument "${name}" is missing from its schema`);
    }
  }
  // The routing rule lives in the description, because the model picks a tool before it reads any
  // prompt section. Without it the browser becomes the default road to every page.
  const open = byName(list).get("browser_open");
  for (const word of ["fetch", "sign-in", "subagent"]) {
    assert.ok(open.description.includes(word), `browser_open's description mentions ${word}`);
  }
});

test("browser_open returns the page's words plus exactly one image", async () => {
  const fake = fakeDependencies({
    ok: true,
    summary: "Opened the page.",
    url: "https://example.com/",
    title: "Example Domain",
    text: "Example Domain. This domain is for use in illustrative examples in documents.",
    screenshot: true,
  });
  const open = byName(tools.createSandDirectBrowserTools(fake.dependencies)).get("browser_open");
  const output = await open.execute({}, { url: "https://example.com" }, { toolCallId: "call-1" });

  assert.equal(output.isError, undefined);
  assert.ok(output.text.includes("Example Domain"), output.text);
  assert.ok(output.text.includes("https://example.com/"), output.text);
  assert.ok(output.text.includes("illustrative examples"), "the page's readable words are in the result");

  // One image, and only one: a single base64 string on the output, one pull off the box, and a
  // render that hands the model an image part rather than a second copy in the text.
  assert.equal(typeof output.imageB64, "string");
  assert.equal(output.imageB64, Buffer.from(SHOT).toString("base64"));
  assert.equal(fake.calls.downloads.length, 1);
  const rendered = open.render(output);
  assert.equal(rendered.kind, "image");
  assert.equal(rendered.imageB64, output.imageB64);
  assert.ok(!rendered.text.includes(output.imageB64), "the image is a part, not pasted into the text");

  // The driver was asked for that one screenshot, on this agent's own display.
  const request = decodeRequest(fake.calls.shell[0]);
  assert.equal(request.op, "open");
  assert.equal(request.url, "https://example.com");
  assert.equal(request.display, 10);
  assert.equal(request.cdpPort, 9232);
  assert.ok(String(request.screenshotPath).endsWith("shot-call-1.png"));
});

test("browser_open writes one browser_navigation row with the page's url and title", async () => {
  const fake = fakeDependencies({
    ok: true, summary: "Opened the page.",
    // A redirect: the ledger should show where the visit landed, not where it was aimed.
    url: "https://www.youtube.com/@TitaniumComputing",
    title: "Titanium Computing - YouTube",
    screenshot: true,
  });
  const open = byName(tools.createSandDirectBrowserTools(fake.dependencies)).get("browser_open");
  await open.execute({}, { url: "https://youtube.com/@TitaniumComputing" }, { toolCallId: "call-2" });
  assert.deepEqual(fake.calls.navigations, [{
    url: "https://www.youtube.com/@TitaniumComputing",
    title: "Titanium Computing - YouTube",
  }]);
});

test("only opening a page writes a row; clicking, typing and looking again do not", async () => {
  const fake = fakeDependencies({ ok: true, summary: "Done.", screenshot: true });
  const list = byName(tools.createSandDirectBrowserTools(fake.dependencies));
  await list.get("browser_click").execute({}, { target: "Sign in" }, { toolCallId: "c" });
  await list.get("browser_type").execute({}, { target: "Search", text: "bread flour", submit: true }, { toolCallId: "t" });
  await list.get("browser_screenshot").execute({}, {}, { toolCallId: "s" });
  assert.deepEqual(fake.calls.navigations, []);
  assert.deepEqual(fake.calls.shell.map((input) => decodeRequest(input).op), ["click", "type", "screenshot"]);
  // Click and type act on what a person would say, not on a snapshot ref.
  assert.equal(decodeRequest(fake.calls.shell[0]).target, "Sign in");
  assert.equal(decodeRequest(fake.calls.shell[1]).text, "bread flour");
  assert.equal(decodeRequest(fake.calls.shell[1]).submit, true);
});

test("a failed open leaves no row behind", async () => {
  const fake = fakeDependencies({ ok: false, error: "The page took too long to load." });
  const open = byName(tools.createSandDirectBrowserTools(fake.dependencies)).get("browser_open");
  const output = await open.execute({}, { url: "https://example.com" }, { toolCallId: "call-3" });
  assert.equal(output.isError, true);
  assert.equal(output.text, "The page took too long to load.");
  assert.deepEqual(fake.calls.navigations, []);
});

test("a page behind a sign-in, and a page the site refused, are reported in plain words", async () => {
  const walled = fakeDependencies({
    ok: true, summary: "Opened the page.", url: "https://app.example.com/login",
    title: "Sign in", needsLogin: true, screenshot: true,
  });
  const open = byName(tools.createSandDirectBrowserTools(walled.dependencies)).get("browser_open");
  const wallText = (await open.execute({}, { url: "https://app.example.com" }, { toolCallId: "w" })).text;
  assert.ok(wallText.includes("sign in on the computer's screen"), wallText);
  // No tool name, no status code: this text is what the person is told.
  for (const jargon of ["browser_open", "401", "403", "HTTP"]) {
    assert.ok(!wallText.includes(jargon), `the sign-in note says nothing about ${jargon}`);
  }

  const refused = fakeDependencies({
    ok: true, summary: "Opened the page.", url: "https://example.com/",
    title: "Just a moment...", blocked: true, screenshot: true,
  });
  const blockedOpen = byName(tools.createSandDirectBrowserTools(refused.dependencies)).get("browser_open");
  const blockedText = (await blockedOpen.execute({}, { url: "https://example.com" }, { toolCallId: "b" })).text;
  assert.ok(blockedText.includes("would not show this page"), blockedText);
  assert.ok(blockedText.includes("another source"), blockedText);
});

test("a driver that answers without the new fields still works, so the fifteen are untouched", async () => {
  const fake = fakeDependencies({ ok: true, summary: "Clicked it.", screenshot: true });
  const click = byName(tools.createSandDirectBrowserTools(fake.dependencies)).get("browser_click");
  const output = await click.execute({}, { target: "button.buy" }, { toolCallId: "call-4" });
  assert.equal(output.text, "Clicked it.");
  assert.equal(output.needsLogin, undefined);
  assert.equal(output.blocked, undefined);
});

// The operator's switch. Default ON, because nothing upstream ever shipped these tools and there
// is no feature gate behind them; the setting can only take them away.
test("SAND_BROWSER_TOOLS is on unless an operator writes it off", () => {
  assert.equal(setting.resolveBrowserToolsEnabled(undefined), true);
  assert.equal(setting.resolveBrowserToolsEnabled(""), true);
  assert.equal(setting.resolveBrowserToolsEnabled("1"), true);
  assert.equal(setting.resolveBrowserToolsEnabled("on"), true);
  assert.equal(setting.resolveBrowserToolsEnabled("0"), false);
  assert.equal(setting.resolveBrowserToolsEnabled("false"), false);
  assert.equal(setting.resolveBrowserToolsEnabled("False"), false);
  assert.equal(setting.SAND_BROWSER_TOOLS_SETTING, "SAND_BROWSER_TOOLS");
});
