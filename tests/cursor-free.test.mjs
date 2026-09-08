// CURSOR-1, the unit half of item 6: the pin file, the fetch fallback order, and the error text.
//
// This file was written against the contract before items 1 to 4 landed, so it is in two parts and
// says which is which rather than pretending to cover both.
//
// The cases that run today are about the product's own decision: `deploy/box-defaults/gates.json`,
// which is what a customer's box starts with. A pin naming a gate that does not exist pins nothing
// and reads exactly like a pin that works, so the names are checked against the recovered flag
// table rather than trusted. That is a real failure mode: the whole point of the file is that no
// box differs from another because of a remote flag, and a typo puts one back.
//
// The cases that are still asleep each name the one thing that wakes them, so an implementer does
// not have to read this file to find out what it wants. They wake on their own when the code lands.
// A test that fails for a year because it was written early is a test somebody deletes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".cursor-free-test-"));
after(() => { rmSync(stage, { recursive: true, force: true }); });

const load = async (relative, name) => {
  if (!existsSync(path.join(repoRoot, relative))) return null;
  try {
    const result = await build({
      entryPoints: [path.join(repoRoot, relative)],
      bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
      external: ["jsonc-parser", "@statsig/js-client"], logLevel: "silent",
    });
    const bundlePath = path.join(stage, `${name}.cjs`);
    writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
    return createRequire(import.meta.url)(bundlePath);
  } catch { return null; }
};

const readSource = (relative) => {
  const absolute = path.join(repoRoot, relative);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
};

const PINS_PATH = "deploy/box-defaults/gates.json";
const SETTINGS_PATH = "deploy/box-defaults/sand-host-settings.json";
const GATE_PATH = "scripts/verify-cursor-free.mjs";
const OVERRIDES_PATH = "source/shared/node/experiments/feature-flag-overrides.ts";
const WEB_TOOLS_PATH = "source/host/extensions/inference/web-tools.ts";
const BACKEND_MODE_PATH = "source/shared/node/backend-mode.ts";

const pins = JSON.parse(readFileSync(path.join(repoRoot, PINS_PATH), "utf8"));
const flags = await load("source/shared/node/experiments/experiment-config.gen.ts", "flags");

// The contract's own words, kept here so a later edit to the template has to argue with them.
const MUST_BE_OFF = [
  "sand_auto_review",
  "grok_bot_dynamic_tools",
  "sand_product_analytics",
  "sand_codebase_telemetry",
  "codebase_telemetry_v2",
  "codebase_telemetry_v2_git_history",
  "codebase_telemetry_v2_agent_dot_dirs",
  "sand_action_audit_logs",
  "sand_notify_bus",
  "sand_notify_safety_poll",
  "sand_enable_pressure_cpu_profiler",
  "sand_box_egress_tunnel",
  "sand_auto_update_when_idle",
];
const MUST_BE_ON = [
  "sand_browser_use_subagent",
  "sand_multitask",
  "sand_spotlight",
  "sand_global_search",
  "sand_computer_use_playwright",
];

test("every gate the box defaults pin is a gate that exists", () => {
  assert.ok(flags != null && flags.FLAGS != null, "the recovered flag table did not load");
  const unknown = Object.keys(pins).filter((name) => !Object.hasOwn(flags.FLAGS, name));
  assert.deepEqual(unknown, [], `${PINS_PATH} pins gates that are not in the flag table, so they pin nothing`);
  const notBoolean = Object.entries(pins).filter(([, value]) => typeof value !== "boolean").map(([name]) => name);
  assert.deepEqual(notBoolean, [], "a gate pin has to be true or false");
});

test("the box defaults hold the product's decision, not Cursor's rollout", () => {
  const wrongOff = MUST_BE_OFF.filter((name) => pins[name] !== false);
  assert.deepEqual(wrongOff, [], "these carry a third party's classifier, telemetry or rollout and must be off for a customer");
  const wrongOn = MUST_BE_ON.filter((name) => pins[name] !== true);
  assert.deepEqual(wrongOn, [], "these are shipped features a live evaluation must never be able to take away");
});

test("the pins that matter most are the ones a bundled default would get wrong", () => {
  // Nine of the eighteen agree with the bundled default today and are pinned anyway, because
  // agreeing today is not a decision. These four are the ones where the bundled default is the
  // opposite of what a customer should get, so if the pin file were ignored the box would be wrong
  // in a way somebody would feel.
  for (const name of ["sand_product_analytics", "codebase_telemetry_v2"]) {
    assert.equal(flags.FLAGS[name]?.default, true, `${name}'s bundled default changed; re-read why it is pinned`);
    assert.equal(pins[name], false, `${name} must be pinned off`);
  }
  assert.equal(flags.FLAGS.sand_browser_use_subagent?.default, false, "the browser gate's bundled default changed");
  assert.equal(pins.sand_browser_use_subagent, true, "Titan has to be able to hold a browser");
});

test("the tenant settings template only holds values the settings reader can read", () => {
  const settings = JSON.parse(readFileSync(path.join(repoRoot, SETTINGS_PATH), "utf8"));
  const notString = Object.entries(settings).filter(([, value]) => typeof value !== "string").map(([name]) => name);
  // readSettingsFile in source/host/sand-box-setting.ts keeps string values and drops everything
  // else without a word, so a number or an object in this file is a switch that silently does
  // nothing on a customer's box.
  assert.deepEqual(notString, [], "the host settings reader keeps strings only");
  assert.ok(Object.hasOwn(settings, "SAND_BACKEND_URL"), "the backend switch is the one a live box can take without a recreate");
  assert.equal(settings.SAND_BACKEND_URL, "", "empty means we have no backend of our own and nothing dials one");
  // Writing shadow here would look harmless and would quietly swallow an operator's later decision
  // to turn review on: resolveSandAutoReviewModes takes localOverride before enforceEnabled.
  assert.ok(!Object.hasOwn(settings, "SAND_AUTO_REVIEW_MODE"),
    "the mode override beats the enforce switch, so the template must leave it alone and let the pin decide");
});

test("the gate reads the template rather than carrying its own copy of it", () => {
  const gate = readSource(GATE_PATH);
  assert.ok(gate != null, `${GATE_PATH} is missing`);
  assert.ok(gate.includes(PINS_PATH),
    `${GATE_PATH} must read ${PINS_PATH}; a second copy of the pins in the gate is two answers to one question`);
});

// ---- asleep until items 1 to 4 land ---------------------------------------------------------

const overridesSource = readSource(OVERRIDES_PATH);
const ttlStillThere = overridesSource != null && overridesSource.includes("FEATURE_FLAG_OVERRIDE_TTL_MS");

test("a pin written a year ago still applies", { skip: ttlStillThere ? `FEATURE_FLAG_OVERRIDE_TTL_MS is still exported from ${OVERRIDES_PATH}; this case wakes when the expiry is gone` : false }, async () => {
  const overrides = await load(OVERRIDES_PATH, "overrides");
  assert.ok(overrides?.SandFeatureFlagOverrideStore != null, "the pin store did not load");
  const dir = mkdtempSync(path.join(stage, "pins-"));
  // Exactly the shape found on the Mac box on 2026-09-07: a pin that turned itself off with the
  // clock six days earlier, with nothing anywhere saying it had.
  writeFileSync(
    path.join(dir, overrides.FEATURE_FLAG_OVERRIDES_FILENAME ?? "sand-feature-flag-overrides.json"),
    JSON.stringify({ overrides: { sand_browser_use_subagent: { value: true, expiresAtMs: Date.now() - 365 * 24 * 60 * 60 * 1000 } } }),
    "utf8",
  );
  const store = new overrides.SandFeatureFlagOverrideStore(() => dir);
  store.hydrateFromDisk();
  assert.equal(store.read("sand_browser_use_subagent"), true,
    "a product pin is a decision, not a 24 hour experiment");
});

const backendMode = await load(BACKEND_MODE_PATH, "backend-mode");

test("an unset backend means none, never Cursor", { skip: backendMode?.getSandBackendMode == null ? `${BACKEND_MODE_PATH} does not export getSandBackendMode yet` : false }, () => {
  const mode = backendMode.getSandBackendMode;
  assert.equal(mode({}), "none", "unset must mean none; this is the default every fresh box takes");
  assert.equal(mode({ SAND_BACKEND_URL: "" }), "none", "empty means none");
  assert.equal(mode({ SAND_BACKEND_URL: "https://api2.cursor.sh/" }), "none",
    "a Cursor host is not a backend of ours, however it got into the environment");
  assert.equal(mode({ SAND_BACKEND_URL: "https://relay.titanium.bot/" }), "ours");
});

const webTools = readSource(WEB_TOOLS_PATH);

test("the web tools are ours", { skip: webTools == null ? `${WEB_TOOLS_PATH} does not exist yet` : false }, () => {
  for (const rpc of ["RunWebSearch", "RunWebFetch", "createCursorWebFetchService", "createCursorWebSearchService"]) {
    assert.ok(!webTools.includes(rpc), `${WEB_TOOLS_PATH} still reaches for ${rpc}`);
  }
});

test("no web tool hands anybody \"may be temporary\"", { skip: webTools == null ? `${WEB_TOOLS_PATH} does not exist yet; the string still lives in connect-error.ts and web-search.ts` : false }, () => {
  // The exact sentence Richard was given eleven times in one session. It tells the person nothing
  // and tells the model to retry a call that can never succeed, so the agent loops.
  for (const relative of [WEB_TOOLS_PATH, "source/packages/agent/tools/core/web-search.ts", "source/packages/agent/tools/core/web-fetch.ts"]) {
    const body = readSource(relative);
    if (body == null) continue;
    assert.ok(!body.toLowerCase().includes("may be temporary"), `${relative} still carries "may be temporary"`);
  }
  const failure = /Could not read that page[^"']*/.exec(webTools)?.[0] ?? "";
  assert.ok(failure.length > 0, "the failure sentence is not in the web tools");
  assert.ok(/in your browser/i.test(failure), "the failure sentence must name the next thing the person can do");
  for (const vendor of ["cursor", "tinyfish", "exa"]) {
    assert.ok(!failure.toLowerCase().includes(vendor), `the failure sentence names ${vendor}; the person asked for something, not for a supplier`);
  }
});

const fallbackProbe = await load(WEB_TOOLS_PATH, "web-tools");
const predicate = fallbackProbe == null ? null : (fallbackProbe.shouldFallBackToFallbackFetch ?? fallbackProbe.shouldFallBack ?? fallbackProbe.directFetchWasRefused ?? null);

test("the fallback order: direct first, fallback only when the site refused", { skip: predicate == null ? `export a predicate from ${WEB_TOOLS_PATH} named shouldFallBack, shouldFallBackToFallbackFetch or directFetchWasRefused, taking { status, body }, to wake this case` : false }, () => {
  assert.equal(predicate({ status: 200, body: "<html><body>hello</body></html>" }), false, "a page that answered must not cost a fallback call");
  assert.equal(predicate({ status: 403, body: "" }), true, "403 is the refusal the fallback exists for");
  assert.equal(predicate({ status: 429, body: "" }), true, "429 is a refusal too");
  assert.equal(predicate({ status: 200, body: "" }), true, "an empty body from a 200 is a JavaScript-only page");
});
