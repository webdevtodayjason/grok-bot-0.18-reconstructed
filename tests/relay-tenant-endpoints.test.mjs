// A tenant console must not be able to aim the relay at this server's own network.
//
// Two surfaces make one hole. POST /endpoints saves any base URL the browser sends, and the health
// probe behind GET /endpoints then fetches `<baseUrl>/models` with an Authorization header the same
// browser chose and hands back the status, the latency and the model list. On Jason's own instance
// that is a feature: it is his machine and the box next door is a legitimate endpoint. On a tenant
// it is a port scanner with a bearer, driven by whoever holds that customer's session. Measured
// from a signed-in tenant session before the guard: the relay answered HTTP 401, the box gateway
// HTTP 404, the host address refused and an off-network address timed out, which is four different
// answers and therefore a working scan of the machine every other customer is on.
//
// So this measures both halves on a real relay on a real port: the save is refused in words a
// business owner can read, the probe never leaves the process, and the same relay WITHOUT tenant
// mode still accepts exactly what the tenant was refused.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAuthRecord, writeAuthFile } from "../ui/auth.mjs";
import { tenantSessionSecret } from "../ui/session-token.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_PASSWORD = "an instance password no test types";
const KEY = tenantSessionSecret("a control plane master key no tenant ever holds", "demo");

// A copy of ui/, never ui/ itself: the operator's own auth.json and endpoints.json are in there.
function serverCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-endpoints-"));
  for (const name of readdirSync(path.join(repo, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repo, "ui", name), path.join(dir, name));
  }
  writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(RELAY_PASSWORD));
  return dir;
}

// Same shape as tests/relay-tenant-login: SAND_UI_PORT=0 prints the value it was given, so a port
// is picked and retried.
async function startRelay(env = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = serverCopy();
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env: {
        ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_TOKEN: "not-a-real-token", SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
        TENANT_ID: "", CP_URL: "", CP_SESSION_SECRET: "", SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "",
        SAND_UI_ENDPOINTS_FILE: "", PATH: "/nonexistent",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listening = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("cfip ")) resolve(out); });
      child.on("exit", () => resolve(null));
      setTimeout(() => resolve(null), 15_000).unref();
    });
    if (listening != null) {
      return { base: `http://127.0.0.1:${port}`, dir, catalog: path.join(dir, "endpoints.json"), stop: () => child.kill("SIGKILL") };
    }
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

async function signIn(relay) {
  const res = await fetch(`${relay.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams({ password: RELAY_PASSWORD }).toString(),
  });
  const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  assert.ok(cookie.length > 0, "the test needs a session before it can call /endpoints");
  return cookie;
}

const save = (relay, cookie, endpoints) => fetch(`${relay.base}/endpoints`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ endpoints }),
});

const row = (baseUrl) => ({ id: "probe", name: "probe", baseUrl, model: "m", apiKey: "a bearer the customer chose" });

test("a tenant cannot save an endpoint that points inside this server's network", async () => {
  const relay = await startRelay({ TENANT_ID: "demo", CP_URL: "http://127.0.0.1:1", CP_SESSION_SECRET: KEY });
  try {
    const cookie = await signIn(relay);

    // The four shapes the live scan used, each refused before anything is written.
    for (const [baseUrl, why] of [
      ["https://192.168.32.3:7777", "the relay itself"],
      ["https://192.168.32.1:8000", "the host, which is where Coolify listens"],
      ["https://10.4.0.9/v1", "any other docker network on this machine"],
      ["https://localhost:1340", "a name that resolves to loopback"],
      ["https://[::1]:1340", "the same thing in the other family"],
      ["https://169.254.169.254/latest", "the link local range cloud metadata sits on"],
      ["https://100.64.3.4", "carrier NAT, which is also every tailnet address"],
    ]) {
      const res = await save(relay, cookie, [row(baseUrl)]);
      assert.equal(res.status, 400, `${baseUrl} (${why}) was accepted`);
      const body = await res.json();
      assert.match(String(body.error), /inside this server's own network/, baseUrl);
    }

    // Plain http is refused too, and so is something that is not an address at all.
    const plain = await save(relay, cookie, [row("http://api.example.com/v1")]);
    assert.equal(plain.status, 400);
    assert.match(String((await plain.json()).error), /have to start with https:\/\//);
    const junk = await save(relay, cookie, [row("not a url")]);
    assert.equal(junk.status, 400);
    assert.match(String((await junk.json()).error), /not a web address/);

    // Nothing was written by any of that.
    let written = "";
    try { written = readFileSync(relay.catalog, "utf8"); } catch { written = ""; }
    assert.equal(written, "", "a refused save must not leave a catalog behind");

    // A public address over https is saved, so the guard is a fence and not a wall. A literal
    // address rather than a name, so this test needs no DNS.
    const ok = await save(relay, cookie, [row("https://93.184.216.34/v1")]);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).saved, 1);
  } finally { relay.stop(); }
});

test("a tenant's health probe does not fetch an address inside this server's network", async () => {
  const relay = await startRelay({ TENANT_ID: "demo", CP_URL: "http://127.0.0.1:1", CP_SESSION_SECRET: KEY });
  try {
    const cookie = await signIn(relay);
    // Past the save guard on purpose: a catalog written before this shipped, or by any other path,
    // still must not be probed. This is the half that leaks the scan.
    writeFileSync(relay.catalog, JSON.stringify({ endpoints: [row("https://192.168.32.1:8000")] }, null, 2));
    const res = await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.endpoints.length, 1);
    const health = body.endpoints[0].health;
    assert.equal(health.reachable, false);
    assert.match(String(health.detail), /inside this server's own network/);
    // The tell that no request left the process: the four answers a scan reads apart are gone.
    assert.equal(health.models, undefined);
    assert.equal(health.serves, undefined);
    // And the key the customer chose is not handed back to them either.
    assert.equal(body.endpoints[0].apiKey, "set");
  } finally { relay.stop(); }
});

test("without tenant mode the same address is still Jason's to point at", async () => {
  // The control. Without this the tests above would pass on a relay that refused everything
  // always, which would take the box next door away from the operator who owns the machine.
  const relay = await startRelay();
  try {
    const cookie = await signIn(relay);
    const res = await save(relay, cookie, [row("http://titanbot-box:1340")]);
    assert.equal(res.status, 200, "the operator's own console may point anywhere it can reach");
    assert.equal((await res.json()).saved, 1);
  } finally { relay.stop(); }
});
