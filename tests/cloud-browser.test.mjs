// CLOUD-BROWSER-1. The routing, the custody and the shape promise, with no box and no vendor.
//
// Four claims are pinned here, and each of them is a thing that would be quietly wrong rather than
// loudly broken if it drifted:
//
//   1. ROUTING. Pinned engine, cloud site list, and AT MOST ONE escalation -- and a pin at a vendor
//      whose key was never stored falls back to the box rather than failing a tool call with a
//      vendor's 401.
//   2. CUSTODY. The cloudBrowser section of the 0600 store never returns a value to a lister and
//      never appears in any environment update. That last one is asserted against
//      buildShellSecretEnvironmentUpdate itself, because the whole value of a third section is the
//      promise that it never becomes the second one -- shell-secrets.ts's own header says its values
//      are merged into the environment of the process that spawns every shell the agent runs.
//   3. THE STOP. A session is stopped on every exit path, including a thrown tool error, because
//      Browser Use documents that closing CDP does not end the browser.
//   4. THE SHAPE. A cloud read and a box read produce the SAME BrowserDriverOutput field set. This
//      is true by construction -- one `#readShellAnswer` parses both -- and it is pinned anyway,
//      because "by construction" is a claim about code that somebody will refactor.
//
// The vendors are fakes in this file. No key is read, nothing is dialled, nothing is metered.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Inside the repo, not in the OS temp dir, so that node can resolve the packages left external
// below from this project's own node_modules at run time.
// The .tmp- prefix is not decoration: .gitignore already ignores /.tmp*/, so a run that dies before
// its cleanup leaves nothing for the next `git status` to trip over.
const buildDir = mkdtempSync(path.join(repoRoot, ".tmp-cloud-browser-"));

/**
 * The host modules bundled to a file and imported from it.
 *
 * A single-file esbuild transform (which web-tools-ours.test.mjs uses) reaches an import-free
 * module; these are not import-free -- the cloud module is seven files and sand-browser-tools.ts
 * pulls the runner's graph -- so they are bundled. Two details, both learned the hard way:
 *
 *   - to a FILE rather than a data: URL, because sand-browser-tools.ts bundles to about 8 MB and
 *     node will not import a data URL that size;
 *   - `packages: "external"` so installed packages are left for node to resolve. Bundling them
 *     drags CommonJS ones (mime-types, by way of the runner's graph) into an ESM output where
 *     their own `require` cannot work, and the import dies on "Dynamic require of path".
 */
async function loadBundle(relativePath, name) {
  const outfile = path.join(buildDir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(repoRoot, relativePath)],
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
  return await import(pathToFileURL(outfile).href);
}

const cloud = await loadBundle("source/host/extensions/inference/cloud-browser/index.ts", "cloud");
const shellSecrets = await loadBundle("source/host/extensions/shell-tools/shell-secrets.ts", "shell-secrets");
const browserTools = await loadBundle("source/host/runner/tools/sand-browser-tools.ts", "browser-tools");

process.on("exit", () => { try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const root = () => mkdtempSync(path.join(tmpdir(), "cloud-browser-root-"));

/* ------------------------------------------------------------------ 1. routing */

const AVAILABLE_BOTH = ["browser-use", "browserbase"];

test("with nothing pinned and no listed site, the box is the default", () => {
  const route = cloud.routeCloudBrowser({
    policy: cloud.DEFAULT_CLOUD_BROWSER_POLICY,
    available: AVAILABLE_BOTH,
    url: "https://example.com/about",
  });
  assert.equal(route.engine, "box");
});

test("a listed site goes to the cloud on the first attempt, no page read needed", () => {
  for (const url of [
    "https://www.instagram.com/titaniumcomputing/",
    "https://facebook.com/some/page",
    "https://www.linkedin.com/company/titanium",
  ]) {
    const route = cloud.routeCloudBrowser({ policy: cloud.DEFAULT_CLOUD_BROWSER_POLICY, available: AVAILABLE_BOTH, url });
    assert.equal(route.engine, "browser-use", `${url} is on the workspace's cloud list`);
  }
});

test("a pin beats the list, in both directions", () => {
  const pinnedToBox = { ...cloud.DEFAULT_CLOUD_BROWSER_POLICY, engine: "box" };
  assert.equal(
    cloud.routeCloudBrowser({ policy: pinnedToBox, available: AVAILABLE_BOTH, url: "https://www.instagram.com/x/" }).engine,
    "box",
  );
  const pinnedToVendor = { ...cloud.DEFAULT_CLOUD_BROWSER_POLICY, engine: "browserbase" };
  assert.equal(
    cloud.routeCloudBrowser({ policy: pinnedToVendor, available: AVAILABLE_BOTH, url: "https://example.com/" }).engine,
    "browserbase",
  );
});

test("a pin at a vendor with no key stored falls back to the box rather than failing the call", () => {
  const route = cloud.routeCloudBrowser({
    policy: { ...cloud.DEFAULT_CLOUD_BROWSER_POLICY, engine: "browserbase" },
    available: ["browser-use"],
    url: "https://example.com/",
  });
  assert.equal(route.engine, "box");
  assert.match(route.reason, /no key is stored/);
});

test("escalation happens on exactly three verdicts and no others", () => {
  assert.equal(cloud.shouldEscalateOnVerdicts({ needsLogin: true }), true);
  assert.equal(cloud.shouldEscalateOnVerdicts({ blocked: true }), true);
  assert.equal(cloud.shouldEscalateOnVerdicts({ emptyShell: true }), true);
  assert.equal(cloud.shouldEscalateOnVerdicts({}), false);
  // A page that simply had little on it is not an escalation, and neither is a failed call.
  assert.equal(cloud.shouldEscalateOnVerdicts({ needsLogin: false, blocked: false, emptyShell: false }), false);
});

test("the per-turn ceiling stops a second escalation dead", () => {
  const policy = { ...cloud.DEFAULT_CLOUD_BROWSER_POLICY, sessionCeilingPerTurn: 1 };
  const first = cloud.routeCloudBrowser({ policy, available: AVAILABLE_BOTH, escalating: true, sessionsThisTurn: 0 });
  assert.equal(first.engine, "browser-use");
  const second = cloud.routeCloudBrowser({ policy, available: AVAILABLE_BOTH, escalating: true, sessionsThisTurn: 1 });
  assert.equal(second.engine, "box");
  assert.match(second.reason, /already opened as many cloud sessions/);
});

test("a workspace that forbids escalation never escalates, however empty the page was", () => {
  const policy = { ...cloud.DEFAULT_CLOUD_BROWSER_POLICY, autoEscalate: false };
  assert.equal(cloud.routeCloudBrowser({ policy, available: AVAILABLE_BOTH, escalating: true }).engine, "box");
});

test("the policy round-trips through its file and a nonsense file reads as the default", () => {
  const dir = root();
  try {
    const written = cloud.writeCloudBrowserPolicy(dir, { engine: "browserbase", cloudSites: ["https://www.x.com/home", "Reddit.com"] });
    assert.equal(written.engine, "browserbase");
    // Hosts are normalised on the way in, so two spellings of one site are one entry.
    assert.deepEqual(written.cloudSites, ["x.com", "reddit.com"]);
    assert.deepEqual(cloud.readCloudBrowserPolicy(dir), written);
    assert.equal(statSync(path.join(dir, cloud.CLOUD_BROWSER_POLICY_FILENAME)).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ 2. custody */

test("the cloudBrowser section holds only the fields it names", () => {
  const dir = root();
  try {
    assert.equal(cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_secret_value"), true);
    assert.equal(cloud.writeCloudBrowserSecret(dir, "PATH", "/tmp/evil"), false, "process control is not a credential");
    assert.equal(cloud.writeCloudBrowserSecret(dir, "SOME_OTHER_KEY", "x"), false, "the allowlist is closed, not open");
    assert.deepEqual(cloud.listCloudBrowserSecretFields(dir), [cloud.BROWSERBASE_KEY_FIELD]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing a lister returns is a value", () => {
  const dir = root();
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_secret_value");
    const listed = JSON.stringify(cloud.listCloudBrowserSecretFields(dir));
    assert.ok(!listed.includes("bb_secret_value"), "a field listing must never carry the value");
    assert.ok(!JSON.stringify(cloud.storedCloudBrowserVendors(dir)).includes("bb_secret_value"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE CUSTODY PROMISE: a cloud browser key never reaches the shell environment", () => {
  const dir = root();
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_secret_value");
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_PROJECT_FIELD, "proj_123");
    // The shell store's own value IS meant to reach the shell. This one is not.
    shellSecrets.writeShellEnvSecret(dir, "CODERABBIT_API_KEY", "cr_value");

    const update = shellSecrets.buildShellSecretEnvironmentUpdate(dir);
    const serialized = JSON.stringify(update);
    assert.equal(update.env.CODERABBIT_API_KEY, "cr_value", "the shell section still reaches the shell");
    assert.ok(!(cloud.BROWSERBASE_KEY_FIELD in update.env), "the cloud browser key must not be in a shell environment");
    assert.ok(!(cloud.BROWSERBASE_PROJECT_FIELD in update.env));
    assert.ok(!serialized.includes("bb_secret_value"), "and its value must not be anywhere in the update");

    // And the write did not knock out the section beside it. writeSecretsDocument preserves what it
    // is not writing, which is the only reason three sections can share one file.
    assert.deepEqual(cloud.listCloudBrowserSecretFields(dir).sort(), [cloud.BROWSERBASE_KEY_FIELD, cloud.BROWSERBASE_PROJECT_FIELD].sort());
    const document = JSON.parse(readFileSync(path.join(dir, "connector-env-secrets.json"), "utf8"));
    assert.ok(document.shell != null && document.cloudBrowser != null, "both sections survive the other's write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vendor with no key stored is not offered as available", () => {
  const dir = root();
  try {
    assert.deepEqual(cloud.storedCloudBrowserVendors(dir), []);
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_secret_value");
    // A key with no project id opens nothing, so it is not "available" yet either.
    assert.deepEqual(cloud.storedCloudBrowserVendors(dir), []);
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_PROJECT_FIELD, "proj_123");
    assert.deepEqual(cloud.storedCloudBrowserVendors(dir), ["browserbase"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ 3 and 4. the seam */

const MARKER = "__SAND_BROWSER_RESULT__";

// One driver answer, the same bytes whichever engine produced it. That is the point: the box and
// the cloud run the SAME host-op.mjs against the SAME page reader, so this line has one shape.
function driverLine(extra = {}) {
  return `\n${MARKER}${JSON.stringify({
    ok: true,
    summary: "Opened the page.",
    url: "https://example.com/",
    title: "Example Domain",
    text: "This domain is for use in illustrative examples.",
    screenshot: false,
    mimeType: "image/jpeg",
    ...extra,
  })}\n`;
}

/**
 * A cloud seam that holds a browser per PAGE, the way the real service does.
 *
 * Every one of these tests used to hand the driver an `open` that minted a session and a `close`
 * the driver called in a finally, which is exactly the shape that made a cloud sign-up impossible:
 * the browser was gone before the tool result existed. The fake now keeps the same book the service
 * keeps -- who holds which page -- so a test that clicks after an open sees what a box sees.
 */
function fakeSeam({ route, shouldEscalate, endpoint, stops = [] }) {
  const held = new Map();
  return {
    held,
    stops,
    route,
    shouldEscalate,
    viewEngine: (viewId) => held.get(viewId)?.engine,
    hold: async ({ viewId, engine }) => {
      const existing = held.get(viewId);
      if (existing !== undefined && existing.engine === engine) return existing.session;
      if (existing !== undefined && existing.session !== null) stops.push(existing.session.sessionId);
      if (engine === "box") {
        held.set(viewId, { engine, session: null });
        return null;
      }
      const session = endpoint();
      held.set(viewId, { engine, session });
      return session;
    },
    releaseView: async (viewId) => {
      const existing = held.get(viewId);
      if (existing === undefined) return;
      held.delete(viewId);
      if (existing.session !== null) stops.push(existing.session.sessionId);
    },
  };
}

/** Everything SandBrowserDriver needs, with the shell and the cloud both faked. */
function harness({ cloudSeam, answers }) {
  const commands = [];
  return {
    commands,
    dependencies: {
      resourceAccessor: { get: () => ({}) },
      getWindowIndex: async () => 3,
      getBoxId: () => "box-1",
      getDefaultViewId: () => "view-1",
      uploadFile: async () => undefined,
      downloadFile: async () => new Uint8Array(),
      executeShell: async (_context, input) => {
        commands.push(input.command);
        return { case: "success", stdout: answers[commands.length - 1] ?? answers[answers.length - 1], exitCode: 0 };
      },
      ...(cloudSeam == null ? {} : { cloudBrowser: cloudSeam }),
    },
  };
}

test("THE SHAPE PROMISE: a cloud read and a box read carry the same fields", async () => {
  const line = driverLine();

  const box = harness({ answers: [line] });
  const boxDriver = new browserTools.SandBrowserDriver(box.dependencies);
  const boxOutput = await boxDriver.run({}, { op: "open", toolCallId: "call-1", args: { url: "https://example.com/" }, useRuntimeDriver: true });

  const stops = [];
  const cloudSeam = fakeSeam({
    stops,
    route: () => ({ engine: "browser-use", reason: "this site is on the workspace's cloud list" }),
    shouldEscalate: () => false,
    endpoint: () => ({ cdpUrl: "wss://vendor.example/session/abc?token=SECRET", sessionId: "sess-1" }),
  });
  const cloudRun = harness({ cloudSeam, answers: [line] });
  const cloudDriver = new browserTools.SandBrowserDriver(cloudRun.dependencies);
  const cloudOutput = await cloudDriver.run({}, { op: "open", toolCallId: "call-2", args: { url: "https://example.com/" }, useRuntimeDriver: true });

  assert.deepEqual(Object.keys(boxOutput).sort(), Object.keys(cloudOutput).sort(), "the field SET is what a caller depends on");
  assert.deepEqual(boxOutput, cloudOutput, "and on the same page the values match too");
  // The browser is HELD after the call now, so the click that follows the open reaches it. The
  // release is what stops it, and every test that needs the stop asks for one.
  assert.deepEqual(stops, [], "the browser stays for the next click");
  await cloudRun.dependencies.cloudBrowser.releaseView("view-1");
  assert.deepEqual(stops, ["sess-1"], "and the release is what stops it");
});

test("a cloud request never puts the endpoint in a command line", async () => {
  // MARKET-17/MARKET-24 in one assertion. argv is readable from any process in the box, the agent's
  // own shell included, and a cloud endpoint carries the session's credential in its own path.
  const stops = [];
  const cloudSeam = fakeSeam({
    stops,
    route: () => ({ engine: "browser-use", reason: "pinned" }),
    shouldEscalate: () => false,
    endpoint: () => ({ cdpUrl: "wss://api.browser-use.example/cdp/abc?token=SUPERSECRET", sessionId: "sess-7" }),
  });
  const run = harness({ cloudSeam, answers: [driverLine()] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  await driver.run({}, { op: "open", toolCallId: "call-3", args: { url: "https://example.com/" }, useRuntimeDriver: true });

  assert.equal(run.commands.length, 1);
  const command = run.commands[0];
  assert.ok(!command.includes("SUPERSECRET"), "the session token must not be in the command");
  assert.ok(!command.includes("browser-use.example"), "nor the vendor's host");
  assert.ok(!command.includes("sess-7"), "nor the session id");
  assert.match(command, /--request-file \S+\.json$/, "the request travels in a file the driver unlinks");

  // And the file itself is 0600 in a 0700 directory, and it does carry the endpoint -- which is the
  // residual this wave states out loud rather than papering over, because the agent's shell is root
  // in the same container until that changes.
  const file = command.split("--request-file ")[1].trim();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.match(readFileSync(file, "utf8"), /SUPERSECRET/);
  rmSync(file, { force: true });
  await cloudSeam.releaseView("view-1");
  assert.deepEqual(stops, ["sess-7"]);
});

test("a box request still travels base64 in argv, exactly as it always did", async () => {
  const run = harness({ answers: [driverLine()] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  await driver.run({}, { op: "open", toolCallId: "call-4", args: { url: "https://example.com/" }, useRuntimeDriver: true });
  assert.match(run.commands[0], /^node \/opt\/titanbot-runtime\/browser-driver\/host-op\.mjs [A-Za-z0-9+/=]+$/);
  const request = JSON.parse(Buffer.from(run.commands[0].split(" ")[2], "base64").toString("utf8"));
  assert.equal(request.display, 3);
  assert.equal(request.cdpPort, 9_225, "the box path still names a display and a loopback port");
  assert.equal(request.cdpUrl, undefined);
});

test("an empty page escalates exactly once, and never twice", async () => {
  const empty = driverLine({ emptyShell: true, emptyShellReason: "the page gave up its menus and none of its content" });
  const alsoEmpty = driverLine({ emptyShell: true, text: "still nothing" });
  const opens = [];
  const cloudSeam = fakeSeam({
    route: (input) => (input.escalating === true
      ? { engine: "browser-use", reason: "the page came back with nothing worth reading" }
      : { engine: "box", reason: "the browser on the box is the default" }),
    shouldEscalate: (verdicts) => verdicts.emptyShell === true,
    endpoint: () => {
      opens.push("open");
      return { cdpUrl: "wss://vendor.example/x", sessionId: `sess-${opens.length}` };
    },
  });
  const run = harness({ cloudSeam, answers: [empty, alsoEmpty] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  const output = await driver.run({}, { op: "open", toolCallId: "call-5", args: { url: "https://www.instagram.com/x/" }, useRuntimeDriver: true });

  assert.equal(run.commands.length, 2, "one box attempt, one cloud attempt");
  assert.equal(opens.length, 1, "and one session, never a ladder of them");
  assert.ok(output.text.includes("gave up almost none of its words"), "the model is told the page said nothing");
});

test("an empty page with no cloud engine available is still SAID, not summarised over", async () => {
  const run = harness({
    cloudSeam: fakeSeam({
      route: () => ({ engine: "box", reason: "no key is stored for it" }),
      shouldEscalate: () => true,
      endpoint: () => { throw new Error("must not be called"); },
    }),
    answers: [driverLine({ emptyShell: true })],
  });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  const output = await driver.run({}, { op: "open", toolCallId: "call-6", args: { url: "https://www.instagram.com/x/" }, useRuntimeDriver: true });
  assert.equal(run.commands.length, 1);
  assert.ok(output.text.includes("gave up almost none of its words"));
  // No vendor name, no tool name, no status code in anything the person reads.
  for (const forbidden of ["browserbase", "Browser Use", "browser_open", "HTTP", "200"]) {
    assert.ok(!output.text.includes(forbidden), `the note must not say "${forbidden}"`);
  }
});

test("THE STOP: a session is stopped even when the tool call throws", async () => {
  const stops = [];
  const cloudSeam = fakeSeam({
    stops,
    route: () => ({ engine: "browser-use", reason: "pinned" }),
    shouldEscalate: () => false,
    endpoint: () => ({ cdpUrl: "wss://vendor.example/x", sessionId: "sess-9" }),
  });
  const dependencies = {
    ...harness({ cloudSeam, answers: [""] }).dependencies,
    executeShell: async () => { throw new Error("the box went away mid-call"); },
  };
  const driver = new browserTools.SandBrowserDriver(dependencies);
  await assert.rejects(async () => await driver.run({}, { op: "open", toolCallId: "call-7", args: { url: "https://example.com/" }, useRuntimeDriver: true }));
  assert.deepEqual(stops, ["sess-9"], "closing CDP does not stop a cloud browser; only the stop does");
});

test("a cloud attempt that fails leaves the box's own answer standing", async () => {
  const boxAnswer = driverLine({ emptyShell: true });
  const cloudFailure = `\n${MARKER}${JSON.stringify({ ok: false, error: "the cloud browser would not start (503)" })}\n`;
  const cloudSeam = fakeSeam({
    route: (input) => (input.escalating === true ? { engine: "browser-use", reason: "empty" } : { engine: "box", reason: "default" }),
    shouldEscalate: (verdicts) => verdicts.emptyShell === true,
    endpoint: () => ({ cdpUrl: "wss://vendor.example/x", sessionId: "sess-10" }),
  });
  const run = harness({ cloudSeam, answers: [boxAnswer, cloudFailure] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  const output = await driver.run({}, { op: "open", toolCallId: "call-8", args: { url: "https://www.instagram.com/x/" }, useRuntimeDriver: true });
  assert.notEqual(output.isError, true, "a vendor's failure is not what the person should be handed");
  assert.ok(output.text.includes("Example Domain"));
});

/* -------------------------------------------- 5. one page, one browser, however many tool calls */

test("THE MULTI-STEP PROMISE: the click after a cloud open reaches the same browser", async () => {
  // The whole reason this wave exists. Measured on the R750's demo box on 2026-09-09, before this:
  // browser_open on instagram.com opened a cloud session and stopped it, and the browser_click that
  // followed carried no address, so it routed from nothing, went to the box's own Chrome, and
  // clicked a page that was never there. A sign-up cannot happen across two browsers.
  const opens = [];
  const cloudSeam = fakeSeam({
    route: (input) => (input.url === undefined
      ? { engine: "box", reason: "the browser on the box is the default" }
      : { engine: "browser-use", reason: "this site is on the workspace's cloud list" }),
    shouldEscalate: () => false,
    endpoint: () => {
      opens.push("open");
      return { cdpUrl: "wss://vendor.example/session/one", sessionId: `sess-${opens.length}` };
    },
  });
  const run = harness({ cloudSeam, answers: [driverLine(), driverLine(), driverLine()] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);

  await driver.run({}, { op: "open", toolCallId: "c1", args: { url: "https://www.instagram.com/x/" }, useRuntimeDriver: true });
  await driver.run({}, { op: "click", toolCallId: "c2", args: { target: "Sign up" }, useRuntimeDriver: true });
  await driver.run({}, { op: "type", toolCallId: "c3", args: { target: "Email", text: "a@b.example" }, useRuntimeDriver: true });

  assert.equal(opens.length, 1, "three tool calls, one browser -- not one browser each");
  assert.equal(run.commands.length, 3);
  for (const command of run.commands) {
    assert.match(command, /--request-file /, "every call went down the cloud road, none fell back to the box");
  }
  const endpoints = run.commands.map((command) => {
    const file = command.split("--request-file ")[1].trim();
    const request = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    return request.cdpUrl;
  });
  assert.deepEqual(new Set(endpoints), new Set(["wss://vendor.example/session/one"]), "and at the same endpoint");
  assert.equal(cloudSeam.viewEngine("view-1"), "browser-use", "the page is still held when the turn ends");
});

test("a page opened in the box is still clicked in the box, whatever the router would say", async () => {
  // The mirror of the test above, and the one that was silently wrong in the other direction: with
  // an engine pinned, a click minted a NEW cloud browser on a blank page and looked for a ref in it.
  const opens = [];
  const cloudSeam = fakeSeam({
    route: () => ({ engine: "browser-use", reason: "this workspace is pinned to a cloud browser" }),
    shouldEscalate: () => false,
    endpoint: () => {
      opens.push("open");
      return { cdpUrl: "wss://vendor.example/x", sessionId: `sess-${opens.length}` };
    },
  });
  // Nothing routed it to the cloud on the way in: the page was opened in the box by an earlier turn.
  await cloudSeam.hold({ viewId: "view-1", engine: "box", reason: "", url: "" });
  const run = harness({ cloudSeam, answers: [driverLine()] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  await driver.run({}, { op: "click", toolCallId: "c9", args: { target: "Sign up" }, useRuntimeDriver: true });

  assert.equal(opens.length, 0, "a click never mints a browser");
  assert.match(run.commands[0], /^node \S+ [A-Za-z0-9+/=]+$/, "it went to the box, base64 in argv as always");
});

test("browser_open at a new address moves the page, and gives the old browser back", async () => {
  const stops = [];
  const cloudSeam = fakeSeam({
    stops,
    route: (input) => (String(input.url ?? "").includes("instagram")
      ? { engine: "browser-use", reason: "this site is on the workspace's cloud list" }
      : { engine: "box", reason: "the browser on the box is the default" }),
    shouldEscalate: () => false,
    endpoint: () => ({ cdpUrl: "wss://vendor.example/x", sessionId: "sess-moved" }),
  });
  const run = harness({ cloudSeam, answers: [driverLine(), driverLine()] });
  const driver = new browserTools.SandBrowserDriver(run.dependencies);
  await driver.run({}, { op: "open", toolCallId: "d1", args: { url: "https://www.instagram.com/x/" }, useRuntimeDriver: true });
  await driver.run({}, { op: "open", toolCallId: "d2", args: { url: "https://example.com/" }, useRuntimeDriver: true });

  assert.deepEqual(stops, ["sess-moved"], "the cloud browser is stopped when the page leaves it");
  assert.equal(cloudSeam.viewEngine("view-1"), "box");
  for (const file of run.commands.filter((c) => c.includes("--request-file ")).map((c) => c.split("--request-file ")[1].trim())) {
    rmSync(file, { force: true });
  }
});
