// BROWSER-1, the prompt half, measured on the rendered text.
//
// "The box desktop" section opened with a flat rule: you cannot touch the desktop, delegate every
// browser and desktop interaction to a subagent, and do not drive the box browser yourself. Once
// Titan holds browser_open / browser_click / browser_type / browser_screenshot that opening is a
// lie, and a model that believes it will refuse to use the tools it was just handed. So the
// paragraph swings on the same switch the toolset gate reads: with the tools on it teaches them
// and the order to reach for them in, with the tools off the old wording comes back untouched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".browser-tools-prompt-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/prompt-collector-glue.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
});
const bundlePath = path.join(stage, "prompt-collector-glue.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const glue = require_(bundlePath);

const desktopSection = (overrides = {}) => glue.createPromptCollectorGlue({
  isSubagentRunner: false,
  remoteBoxHasDesktop: true,
  ...overrides,
}).getComputerSection();

// The sentences the old section opened with, which are what a model reads as "hands off the
// browser". Which one renders depends on whether the browserUse subagent is offered at all.
const OLD_DELEGATE_ALL = "Delegate every browser and desktop interaction to a subagent";
const OLD_DELEGATE_DESKTOP = "Delegate every desktop interaction to a computerUse subagent";

test("with the tools on, the section teaches them and the order to reach for them in", () => {
  // Undefined is the default-on answer, the same one buildTurnTools uses.
  const text = desktopSection();
  assert.ok(!text.includes(OLD_DELEGATE_ALL), "the flat delegate-everything rule is gone");
  assert.ok(!text.includes(OLD_DELEGATE_DESKTOP), "and so is its computerUse-only twin");
  assert.ok(text.includes("The browser is yours for a single page"), text.slice(0, 400));
  for (const name of ["browser_open", "browser_click", "browser_type", "browser_screenshot"]) {
    assert.ok(text.includes(name), `${name} is named for the model`);
  }
  // Fetch, then TinyFish, then the browser -- in that order, with the browser last.
  const fetchAt = text.indexOf("WebFetch");
  const tinyfishAt = text.indexOf("TinyFish");
  const browserAt = text.indexOf("Open it in the browser only after those");
  assert.ok(fetchAt > 0 && tinyfishAt > fetchAt && browserAt > tinyfishAt,
    `the ladder reads fetch, TinyFish, browser (got ${fetchAt}, ${tinyfishAt}, ${browserAt})`);
  // One page yourself, a long job to a subagent.
  assert.ok(text.includes("One page you do yourself; a job you hand off"), "the split is stated");
  // The person never hears a tool name, and a walled page is a plain-words hand-off.
  assert.ok(text.includes("Never say a tool's name to the person"), "the naming rule is stated");
  assert.ok(text.includes("sign in on the computer's screen"), "the sign-in hand-off is stated");
  assert.ok(text.includes("pick the page back up once they have"), "and it says Titan will carry on");
});

test("with the tools switched off the old wording comes back and nothing teaches a missing tool", () => {
  const text = desktopSection({ isBrowserToolsEnabled: () => false });
  assert.ok(text.includes(OLD_DELEGATE_DESKTOP), "the delegate-everything rule is restored");
  assert.ok(
    desktopSection({ isBrowserToolsEnabled: () => false, isBrowserUseSubagentEnabled: () => true })
      .includes(OLD_DELEGATE_ALL),
    "and the browserUse arm gets its own original wording back too",
  );
  for (const name of ["browser_open", "browser_click", "browser_type", "browser_screenshot"]) {
    assert.ok(!text.includes(name), `${name} is not taught when it is not offered`);
  }
  assert.ok(!text.includes("TinyFish"), "no ladder that ends in a browser the model does not have");
});

test("the browserUse arm still routes the long jobs, and stops claiming every page", () => {
  const on = desktopSection({ isBrowserUseSubagentEnabled: () => true });
  assert.ok(on.includes("`browserUse` subagent for browser work that runs past a page or two"),
    "the subagent gets the long jobs, not every page");
  assert.ok(on.includes("The browser is yours for a single page"), "and the four tools ride alongside it");
  // With the tools off, the arm goes back to claiming everything that happens in a browser.
  const off = desktopSection({ isBrowserUseSubagentEnabled: () => true, isBrowserToolsEnabled: () => false });
  assert.ok(off.includes("Reach for the `browserUse` subagent first for anything that happens in the browser"));
  assert.ok(!off.includes("The browser is yours for a single page"));
});

test("a subagent never gets the section at all", () => {
  assert.equal(desktopSection({ isSubagentRunner: true }), null);
});
