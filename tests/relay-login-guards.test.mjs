// The login guards that exist only as behaviour, so a helper test cannot reach them.
//
// The first is the relay refusing to bind a reachable address with no password. That refusal is
// the whole "by construction" claim: a titanbot install without a password serves nothing rather
// than serving an open console, and nothing else in the tree enforces it.
//
// The second is which 401 sends the console to the login. The relay marks its own refusal; the
// gateway's 401 means the relay's bearer is stale, and bouncing on that is a loop the operator
// cannot escape by typing the right password.
//
// The third is the bearer minting a session, and the fourth is the desktop proxy sitting behind
// the same login on both of its halves. Both are further down, after the helper that starts a
// relay copy on a real port.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
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

// The third guard: a bearer on a page request mints a session cookie.
//
// A browser handed the gateway token as a header lands on the console and then does browser
// things -- an EventSource with no custom header, an iframe with none either -- and every one of
// those was refused. Holding the token is already full access, so the cookie takes nothing away;
// it puts the access somewhere the browser keeps sending it. The gates depend on this: headless
// Chrome cannot type a password nobody but the operator knows.
const TEST_TOKEN = "a".repeat(64);

// A relay listening on a real port, with a real auth.json, so the tests below exercise the
// request path rather than a helper. The port is picked at random and retried, because there is
// no way to read back the port from a server started with SAND_UI_PORT=0: it prints the value it
// was given, not the one the kernel chose.
async function startRelay() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = serverCopy();
    const dir = path.dirname(entry);
    const { newAuthRecord, writeAuthFile } = await import("../ui/auth.mjs");
    writeAuthFile(path.join(dir, "auth.json"), newAuthRecord("a password no test types"));
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_TOKEN: TEST_TOKEN,
        // Nothing must answer here. Every call in these tests is decided by the login before the
        // relay ever reaches upstream, and a 502 from an unreachable gateway is itself the proof
        // that a request got past the door.
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listening = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("auth password login")) resolve(true); });
      child.on("exit", () => resolve(false));
      setTimeout(() => resolve(false), 10_000).unref();
    });
    if (listening) return { base: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGKILL") };
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

test("a bearer on a page request mints a session, and that session works on its own", async () => {
  const relay = await startRelay();
  try {
    const page = await fetch(`${relay.base}/`, {
      redirect: "manual", headers: { accept: "text/html", authorization: `Bearer ${TEST_TOKEN}` },
    });
    const setCookie = page.headers.get("set-cookie") ?? "";
    const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(setCookie)?.[1] ?? "";
    assert.ok(cookie.length > 0, `no session cookie was set: ${setCookie || "(no set-cookie)"}`);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Max-Age=43200/);

    // The cookie alone, with no authorization header at all. A 401 would mean the mint was
    // decoration; anything else means the request got past the login. This copy's gateway is a
    // dead port, so what it gets past the login to is a 502.
    const replay = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    assert.notEqual(replay.status, 401);
    assert.equal(replay.headers.get("x-relay-auth"), null);
  } finally { relay.stop(); }
});

test("no bearer mints nothing, and an /api call with one is not given a session it never asked for", async () => {
  const relay = await startRelay();
  try {
    const anonymous = await fetch(`${relay.base}/`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(anonymous.status, 302);
    assert.match(String(anonymous.headers.get("location")), /^\/login/);
    assert.equal(anonymous.headers.get("set-cookie"), null);

    const api = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
      body: "{}",
    });
    assert.equal(api.headers.get("set-cookie"), null);
  } finally { relay.stop(); }
});

// The desktop route carries the box's screen and its keyboard, and a websocket upgrade never
// reaches the request handler that checks the login. So it is checked again on the upgrade, and
// this is the test that says so: without a credential neither half of /vnc answers.
test("the desktop proxy is behind the same login, over HTTP and over the upgrade", async () => {
  const relay = await startRelay();
  try {
    const asset = await fetch(`${relay.base}/vnc/2/vnc.html`, { redirect: "manual", headers: { accept: "*/*" } });
    assert.equal(asset.status, 401);
    assert.equal(asset.headers.get("x-relay-auth"), "required");

    const { port } = new URL(relay.base);
    const answer = await new Promise((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write("GET /vnc/2/websockify HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
          + "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      });
      let seen = "";
      socket.on("data", (chunk) => { seen += chunk; });
      socket.on("close", () => resolve(seen));
      socket.on("error", () => resolve(seen));
      setTimeout(() => { socket.destroy(); resolve(seen); }, 5000).unref();
    });
    assert.match(answer, /^HTTP\/1\.1 401/);
  } finally { relay.stop(); }
});
