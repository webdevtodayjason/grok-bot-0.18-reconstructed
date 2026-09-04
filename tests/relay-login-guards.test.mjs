// The two login guards that exist only as behaviour, so a helper test cannot reach them.
//
// The first is the relay refusing to bind a reachable address with no password. That refusal is
// the whole "by construction" claim: a titanbot install without a password serves nothing rather
// than serving an open console, and nothing else in the tree enforces it.
//
// The second is which 401 sends the console to the login. The relay marks its own refusal; the
// gateway's 401 means the relay's bearer is stale, and bouncing on that is a loop the operator
// cannot escape by typing the right password.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A copy, never ui/ itself: the operator's own ui/auth.json would change which branch runs, and a
// test that silently stops testing anything is worse than no test.
function serverCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-bind-"));
  for (const name of ["server.mjs", "auth.mjs", "subscriptions.mjs"]) {
    copyFileSync(path.join(repoRoot, "ui", name), path.join(dir, name));
  }
  return path.join(dir, "server.mjs");
}

function runServer(entry, env, { waitForListen = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, SAND_UI_PORT: "0", SAND_HOST_GATEWAY_TOKEN: "not-a-real-token", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const done = (code) => resolve({ code, out, err });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      // The listen callback ran, which is the branch under test; nothing is served, so stop here.
      if (waitForListen && out.includes("auth ")) { child.kill("SIGKILL"); done(null); }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => done(code));
    setTimeout(() => { child.kill("SIGKILL"); done(null); }, 10_000).unref();
  });
}

test("the relay refuses to bind a reachable address with no password", async () => {
  const entry = serverCopy();
  for (const host of ["0.0.0.0", "100.110.83.82", "::"]) {
    const { code, err } = await runServer(entry, { SAND_UI_BIND_HOST: host });
    assert.equal(code, 1, `${host} must exit 1, said ${code}`);
    assert.match(err, /refusing to bind/);
    // The refusal has to carry the way out of it, because the operator meets it in a container log.
    assert.match(err, /set-password\.mjs/);
  }
});

test("the relay still starts on loopback with no password, which is this Mac's workflow", async () => {
  const { code, out, err } = await runServer(serverCopy(), { SAND_UI_BIND_HOST: "127.0.0.1" }, { waitForListen: true });
  assert.equal(code, null, `it exited (${code}) instead of listening: ${err}`);
  assert.match(out, /auth none \(loopback, no ui\/auth\.json\)/);
});

// The adapter is browser code with no module system, so it is loaded the way the page loads it:
// the IIFE, invoked with a stub window, with one extra line exposing the function under test.
function loadRelayFetch({ status, headers = {} }) {
  const source = readFileSync(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace("  global.__bootMachineRoom =", "  global.__test = { relayFetch };\n  global.__bootMachineRoom =");
  const navigations = [];
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    location: { pathname: "/", search: "", assign: (to) => navigations.push(to) },
  };
  const fetchStub = async (url) => (String(url).startsWith("/api/")
    ? { ok: false, status, headers: { get: (name) => headers[name] ?? null }, text: async () => JSON.stringify({ error: "no" }) }
    : { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) });
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return { ...fn(window, fetchStub), navigations };
}

test("the console goes to the login only for the relay's own 401", async () => {
  const ours = loadRelayFetch({ status: 401, headers: { "x-relay-auth": "required" } });
  await assert.rejects(() => ours.relayFetch("/api/getHostStatus"), /signed out/);
  assert.deepEqual(ours.navigations, ["/login?next=%2F"]);
});

test("a 401 the gateway produced is reported, not turned into a login loop", async () => {
  // No marker header: this is the upstream refusing the relay's bearer. The password is not the
  // fault, so the page must not navigate; it gets the response and says what went wrong.
  const upstream = loadRelayFetch({ status: 401 });
  const response = await upstream.relayFetch("/api/getHostStatus");
  assert.equal(response.status, 401);
  assert.deepEqual(upstream.navigations, []);
});
