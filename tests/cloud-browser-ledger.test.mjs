// CLOUD-BROWSER-1. The ledger: the row that goes down BEFORE the connect, and the sweep that reads
// the vendor before it stops anything.
//
// Why these two in particular. A cloud browser costs money in two units and one of them is thirty
// times the other: Browser Use is $0.02 a browser-hour with a residential proxy on by default at
// $5/GB, Browserbase is $0.10-0.12 an hour with proxy at $10-12/GB. So:
//
//   - a session whose row is written only after a successful connect is invisible exactly when it
//     matters, because the session nobody can find is the one that was opened and then orphaned;
//   - a proxy figure written as 0 where the vendor publishes none reads as "this session was free",
//     which is the most expensive wrong number the ledger could carry;
//   - and closing the CDP socket does not stop a Browser Use browser -- their docs say so -- so a
//     sweep that stops without asking is either a wasted call or somebody else's session.
//
// No vendor is dialled. The two adapters are faked; the ledger is a real file in a temp directory.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// .tmp- so .gitignore's /.tmp*/ already covers a directory a crash left behind.
const buildDir = mkdtempSync(path.join(repoRoot, ".tmp-cloud-ledger-"));

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
const ledger = await loadBundle("source/host/extensions/inference/cloud-browser/ledger.ts", "ledger");

process.on("exit", () => { try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const root = () => mkdtempSync(path.join(tmpdir(), "cloud-ledger-root-"));
const lines = (dir) => readFileSync(ledger.cloudBrowserLedgerPath(dir), "utf8")
  .split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));

const OPENED = {
  boxName: "0e6e57702ef1",
  agentId: "agent-1",
  vendor: "browserbase",
  sessionId: "sess-abc",
  reason: "this site is on the workspace's cloud list",
  url: "https://www.instagram.com/titaniumcomputing/",
};

test("the open row is written before anything else, and it names the session", () => {
  const dir = root();
  try {
    const row = ledger.recordCloudSessionOpened(dir, OPENED);
    const written = lines(dir);
    assert.equal(written.length, 1);
    assert.equal(written[0].event, "opened");
    assert.equal(written[0].sessionId, "sess-abc");
    assert.equal(written[0].endedAt, null, "an open session is visibly unfinished");
    assert.equal(written[0].minutes, null);
    assert.equal(written[0].proxyBytes, null);
    assert.equal(written[0].boxName, "0e6e57702ef1", "the row says which BOX, because that is all a box knows about itself");
    assert.ok(Date.parse(row.startedAt) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger is 0600 and carries no secret", () => {
  const dir = root();
  try {
    const row = ledger.recordCloudSessionOpened(dir, OPENED);
    ledger.recordCloudSessionClosed(dir, row, { proxyBytes: 12_345 });
    assert.equal(statSync(ledger.cloudBrowserLedgerPath(dir)).mode & 0o777, 0o600);
    const text = readFileSync(ledger.cloudBrowserLedgerPath(dir), "utf8");
    // The session id is in it on purpose; the endpoint that carries the session's credential is not,
    // and neither is any key.
    assert.ok(text.includes("sess-abc"));
    assert.ok(!/wss:\/\//.test(text), "no endpoint in the ledger");
    assert.ok(!/api[-_]?key/i.test(text), "and nothing that looks like a key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the two lines fold into one row, and the money lands on it", () => {
  const dir = root();
  try {
    const row = ledger.recordCloudSessionOpened(dir, OPENED);
    ledger.recordCloudSessionClosed(dir, row, { proxyBytes: 104_857_600 });
    assert.equal(lines(dir).length, 2, "the file is append-only; nothing is rewritten");
    const folded = ledger.readCloudBrowserLedger(dir);
    assert.equal(folded.length, 1, "and a reader sees one row per session");
    assert.equal(folded[0].sessionId, "sess-abc");
    assert.equal(folded[0].proxyBytes, 104_857_600);
    assert.ok(typeof folded[0].minutes === "number" && folded[0].minutes >= 0);
    assert.ok(Date.parse(folded[0].endedAt) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vendor that publishes no proxy figure records null, never zero", () => {
  const dir = root();
  try {
    const row = ledger.recordCloudSessionOpened(dir, { ...OPENED, vendor: "browser-use", sessionId: "sess-bu" });
    ledger.recordCloudSessionClosed(dir, row, { proxyBytes: null });
    const folded = ledger.readCloudBrowserLedger(dir);
    assert.equal(folded[0].proxyBytes, null, "zero would read as free, and a residential exit is not");

    const totals = ledger.summariseCloudBrowserLedger(folded);
    assert.equal(totals.proxyBytes, null);
    assert.deepEqual(totals.proxyReportedBy, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the month's totals name which vendors actually reported traffic", () => {
  const dir = root();
  try {
    const bb = ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "s1", vendor: "browserbase" });
    ledger.recordCloudSessionClosed(dir, bb, { proxyBytes: 2_000_000 });
    const bu = ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "s2", vendor: "browser-use" });
    ledger.recordCloudSessionClosed(dir, bu, { proxyBytes: null });
    ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "s3", vendor: "browser-use" });

    const totals = ledger.summariseCloudBrowserLedger(ledger.readCloudBrowserLedger(dir));
    assert.equal(totals.sessions, 3);
    assert.equal(totals.proxyBytes, 2_000_000);
    assert.deepEqual(totals.proxyReportedBy, ["browserbase"]);
    assert.equal(totals.open, 1, "the session that never closed stays visible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed line is skipped rather than taking the whole ledger down", () => {
  const dir = root();
  try {
    ledger.recordCloudSessionOpened(dir, OPENED);
    writeFileSync(ledger.cloudBrowserLedgerPath(dir), `${readFileSync(ledger.cloudBrowserLedgerPath(dir), "utf8")}not json at all\n{"no":"session id"}\n`);
    assert.equal(ledger.readCloudBrowserLedger(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger that does not exist is no sessions, never an error", () => {
  const dir = root();
  try {
    assert.deepEqual(ledger.readCloudBrowserLedger(dir), []);
    assert.deepEqual(ledger.openCloudSessions(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the sweep */

test("THE SWEEP READS BEFORE IT STOPS, on every row", async () => {
  const dir = root();
  try {
    ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "running-1", vendor: "browser-use" });
    ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "already-gone", vendor: "browser-use" });
    const closed = ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "finished", vendor: "browser-use" });
    ledger.recordCloudSessionClosed(dir, closed, {});

    const calls = [];
    const result = await ledger.sweepOpenCloudSessions(dir, {
      "browser-use": {
        isRunning: async (sessionId) => { calls.push(["read", sessionId]); return sessionId === "running-1"; },
        stop: async (sessionId) => { calls.push(["stop", sessionId]); },
      },
    });

    assert.equal(result.checked, 2, "a session that already closed is not swept");
    assert.equal(result.stopped, 1);
    // The order is the assertion: every stop is preceded by a read of the same session, and the
    // session the vendor says is gone is never stopped.
    assert.deepEqual(calls, [["read", "running-1"], ["stop", "running-1"], ["read", "already-gone"]]);
    assert.deepEqual(ledger.openCloudSessions(dir), [], "and the sweep closes the rows it settled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vendor the sweep cannot reach is reported rather than assumed stopped", async () => {
  const dir = root();
  try {
    ledger.recordCloudSessionOpened(dir, { ...OPENED, sessionId: "orphan", vendor: "browserbase" });
    // No port for that vendor: its key is not stored any more, so nothing can ask about it.
    const result = await ledger.sweepOpenCloudSessions(dir, {});
    assert.equal(result.unreachable, 1);
    assert.equal(result.stopped, 0);
    assert.equal(ledger.openCloudSessions(dir).length, 1, "an orphan we could not settle stays visible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the service, end to end */

test("the service writes the open row before it connects, and stops on the way out", async () => {
  const dir = root();
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_key");
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_PROJECT_FIELD, "proj_1");

    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      // Nothing here is a real endpoint and no key is checked; the shapes are the vendor's own,
      // read from docs.browserbase.com/reference/api/create-a-session on 2026-09-09.
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: "bb-1", status: "RUNNING", connectUrl: "wss://connect.browserbase.example/x?signingKey=abc", proxyBytes: 0 }) };
      }
      if (url.endsWith("/debug")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ debuggerFullscreenUrl: "https://live.browserbase.example/x" }) };
      }
      if (init?.method === "POST") return { ok: true, status: 200, text: async () => "{}" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "bb-1", status: "COMPLETED", proxyBytes: 7_654_321 }) };
    };

    const register = new cloud.CloudBrowserLiveRegister();
    const service = new cloud.CloudBrowserService({
      rootDir: dir,
      fetch: fakeFetch,
      getBoxName: () => "0e6e57702ef1",
      getAgentId: () => "agent-1",
    }, register);

    const lease = await service.open({
      vendor: "browserbase",
      route: { engine: "browserbase", reason: "pinned" },
      url: "https://www.instagram.com/titaniumcomputing/",
    });

    // The row is on disk BEFORE anything downstream can fail.
    assert.equal(ledger.openCloudSessions(dir).length, 1);
    assert.equal(lease.handle.cdpUrl, "wss://connect.browserbase.example/x?signingKey=abc");
    assert.equal(register.forAgent("agent-1").length, 1, "the console can find the live view while it is open");
    assert.equal(register.forAgent("agent-1")[0].liveViewUrl, "https://live.browserbase.example/x");

    await lease.close();
    assert.equal(register.forAgent("agent-1").length, 0, "and cannot find it after it ends");
    const folded = ledger.readCloudBrowserLedger(dir);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].proxyBytes, 7_654_321, "the proxy figure is read back AFTER the browsing, not off the create answer");
    assert.equal(folded[0].boxName, "0e6e57702ef1");

    // The read comes before the stop, so the figure is the session's real traffic.
    const readAt = seen.findIndex((call) => call === "GET https://api.browserbase.com/v1/sessions/bb-1");
    const stopAt = seen.findIndex((call, index) => index > 0 && call === "POST https://api.browserbase.com/v1/sessions/bb-1");
    assert.ok(readAt >= 0 && stopAt > readAt, `expected a read then a stop, got ${JSON.stringify(seen)}`);

    // Calling close twice is safe: a stop that ran once must not run again.
    const before = seen.length;
    await lease.close();
    assert.equal(seen.length, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the per-turn ceiling is enforced by the service, not only by the policy function", async () => {
  const dir = root();
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_KEY_FIELD, "bb_key");
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSERBASE_PROJECT_FIELD, "proj_1");
    cloud.writeCloudBrowserPolicy(dir, { engine: "browserbase", sessionCeilingPerTurn: 1 });

    let opened = 0;
    const fakeFetch = async (url, init) => {
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        opened += 1;
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: `bb-${opened}`, connectUrl: "wss://x.example/y" }) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const service = new cloud.CloudBrowserService({
      rootDir: dir, fetch: fakeFetch, getBoxName: () => "0e6e57702ef1", getAgentId: () => "agent-1",
    }, new cloud.CloudBrowserLiveRegister());

    assert.equal(service.route({ url: "https://example.com/" }).engine, "browserbase");
    const lease = await service.open({ vendor: "browserbase", route: { engine: "browserbase", reason: "pinned" }, url: "https://example.com/" });
    assert.equal(service.route({ url: "https://example.com/" }).engine, "box", "the second page in the same turn stays on the box");
    await lease.close();
    // A new turn gets the allowance back.
    service.beginTurn("agent-1");
    assert.equal(service.route({ url: "https://example.com/" }).engine, "browserbase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser is held for the page, not for the call, and given back on release", async () => {
  // CLOUD-BROWSER-2's real cause. The service used to hand out a lease the driver stopped in its
  // own finally, so every tool call was a fresh browser on a fresh blank page and nothing
  // multi-step -- a sign-up, a login, a code -- could ever be finished.
  const dir = mkdtempSync(path.join(tmpdir(), "cloud-hold-"));
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSER_USE_KEY_FIELD, "bu_key");
    let opened = 0;
    const stopped = [];
    const fakeFetch = async (url, init) => {
      if (init?.method === "POST" && url.includes("/browsers")) {
        opened += 1;
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: `bu-${opened}`, cdpUrl: "wss://x.example/one", liveUrl: "https://live.example/one" }) };
      }
      if (init?.method === "PATCH") {
        stopped.push(url);
        return { ok: true, status: 200, text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const service = new cloud.CloudBrowserService({
      rootDir: dir, fetch: fakeFetch, getBoxName: () => "0e6e57702ef1", getAgentId: () => "agent-1",
    }, new cloud.CloudBrowserLiveRegister());

    assert.equal(service.viewEngine("view-1"), undefined, "nothing holds a page nobody has opened");
    const first = await service.hold({ viewId: "view-1", engine: "browser-use", reason: "pinned", url: "https://example.com/" });
    assert.equal(first.cdpUrl, "wss://x.example/one");
    const again = await service.hold({ viewId: "view-1", engine: "browser-use", reason: "pinned", url: "" });
    assert.deepEqual(again, first, "the second call gets the browser the first one took");
    assert.equal(opened, 1, "one browser, two calls");
    assert.equal(service.viewEngine("view-1"), "browser-use");

    // A turn boundary must NOT take it away: the hand-off card ends the turn on purpose, and the
    // person finishes the step in that browser's live view before the bot picks it up again.
    service.beginTurn("agent-1");
    assert.equal(service.viewEngine("view-1"), "browser-use", "a new turn does not throw the page away");
    assert.equal(service.live.all().length, 1, "and the console can still show it");

    await service.releaseView("view-1");
    assert.equal(service.viewEngine("view-1"), undefined);
    assert.equal(service.live.all().length, 0);
    assert.equal(stopped.length, 1, "the release is what stops the vendor's browser");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held browser is given back when nothing has used it for a while", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cloud-idle-"));
  try {
    cloud.writeCloudBrowserSecret(dir, cloud.BROWSER_USE_KEY_FIELD, "bu_key");
    const fakeFetch = async (url, init) => {
      if (init?.method === "POST" && url.includes("/browsers")) {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: "bu-idle", cdpUrl: "wss://x.example/one" }) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const service = new cloud.CloudBrowserService({
      rootDir: dir, fetch: fakeFetch, getBoxName: () => "0e6e57702ef1", getAgentId: () => "agent-1", viewIdleMs: 20,
    }, new cloud.CloudBrowserLiveRegister());
    await service.hold({ viewId: "view-1", engine: "browser-use", reason: "pinned", url: "https://example.com/" });
    assert.equal(service.viewEngine("view-1"), "browser-use");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(service.viewEngine("view-1"), undefined, "an idle browser is money nobody is spending on purpose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row written before the field was named honestly still reads back", () => {
  // The ledger is a receipt. Rows already on live boxes carry the box's own name under `tenant`,
  // and they are read as what they are rather than rewritten -- rewriting a receipt is the opposite
  // of keeping one.
  const dir = mkdtempSync(path.join(tmpdir(), "cloud-old-row-"));
  try {
    const old = {
      tenant: "0e6e57702ef1", agentId: "agent-1", vendor: "browser-use", sessionId: "old-1",
      startedAt: "2026-09-09T16:59:44.591Z", endedAt: "2026-09-09T16:59:50.002Z", minutes: 0.09,
      proxyBytes: null, engine: "browser-use", reason: "pinned", url: "https://example.com/",
    };
    writeFileSync(ledger.cloudBrowserLedgerPath(dir), `${JSON.stringify({ ...old, event: "closed" })}\n`);
    const [row] = ledger.readCloudBrowserLedger(dir);
    assert.equal(row.boxName, "0e6e57702ef1", "the old field is read under the new name");
    assert.equal(row.tenant, undefined, "and nothing goes on calling a container id a tenant");
    assert.equal(row.minutes, 0.09);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
