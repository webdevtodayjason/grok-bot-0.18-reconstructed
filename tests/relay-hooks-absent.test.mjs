// ui/relay-hooks.mjs, both ways: with each optional module ABSENT and with each one PRESENT.
//
// WHY BOTH HALVES ARE IN ONE FILE. The absent half is the one that matters in production -- the apps
// wave ships in three pieces and any of the three can land later than this one -- but an absent-module
// test on its own proves nothing about the seam, because a hook that is never called also "falls back"
// correctly. So each leg has a pair: with no module the relay answers exactly what it answered before
// the seam existed, and with a stub module in the same directory the stub's answer is on the wire. If
// the second half fails, the first half was measuring nothing.
//
// This is the lesson CONSOLE-4 already paid for: ui/machine-room/backgrounds.js destructured a global
// that was not there and took the picker down, and a comment saying "optional" would have read exactly
// the same as the code that was not.
//
// The stubs are written into the relay's own copy directory. tests/relay-tenant-support.mjs's
// serverCopy() copies ui/*.mjs into a temp dir and starts the server from there, so a file dropped
// beside it is imported by the real loader with no mocking anywhere.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RELAY_PASSWORD, startRelay } from "./relay-tenant-support.mjs";

const json = { "content-type": "application/json" };

// serverCopy() copies ui/*.mjs and nothing else, so the copy has no machine-room directory and every
// static path is a 404. Two small files is all the static branch needs to be exercised, and writing
// them here rather than copying the real frontend keeps the legs reading one asset of known bytes
// instead of whatever the console currently ships.
function seedFrontend(dir) {
  const room = path.join(dir, "machine-room");
  mkdirSync(room, { recursive: true });
  writeFileSync(path.join(room, "app.js"), "export const hooksAbsentFixture = 1;\n");
  writeFileSync(path.join(room, "index.html"), "<!doctype html>\n<html>\n<head>\n<title>fixture</title>\n</head>\n<body>ok</body>\n</html>\n");
  return room;
}

// A relay whose copy directory has the named stubs written into it BEFORE it boots. startRelay makes a
// fresh copy per attempt, so the stubs go in through a second copy rather than by reaching into the
// first: the loader reads them at import time and there is no later window to write in.
async function relayWith(stubs, env = {}) {
  // One attempt at a time, and the stubs are written between the copy and the boot. startRelay does
  // both in one call, so the shape here is: start a relay, stop it, write the stubs into the directory
  // it made, then start a second process from that same directory.
  const first = await startRelay(env, { prefix: "hooks-" });
  first.stop();
  seedFrontend(first.dir);
  for (const [name, source] of Object.entries(stubs)) writeFileSync(path.join(first.dir, name), source);
  const { spawn } = await import("node:child_process");
  const port = 41000 + Math.floor(Math.random() * 6000);
  const child = spawn(process.execPath, [path.join(first.dir, "server.mjs")], {
    env: {
      ...process.env,
      SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_HOST_GATEWAY_TOKEN: "not-a-real-token", SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
      CP_URL: "", CP_RELAY_TOKEN: "", SAND_UI_TENANTS_FILE: "",
      SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "", SAND_UI_ENDPOINTS_FILE: "",
      SAND_PROFILE_DIRS: "", TITAN_JOB_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const boot = await new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("cfip ")) resolve(out); });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("exit", () => resolve(null));
    setTimeout(() => resolve(null), 20_000).unref();
  });
  if (boot == null) { child.kill("SIGKILL"); throw new Error("the relay would not start with those stubs"); }
  return { base: `http://127.0.0.1:${port}`, dir: first.dir, boot, stop: () => child.kill("SIGKILL") };
}

const bearerFor = async (relay) => {
  const res = await fetch(`${relay.base}/auth/token`, {
    method: "POST", headers: json,
    body: JSON.stringify({ password: RELAY_PASSWORD, device: { name: "a gate", platform: "desktop" } }),
  });
  return (await res.json()).token;
};

// ---- absent: the relay is exactly what it was -------------------------------------------------

test("with none of the three modules the relay boots, says so, and behaves as it did", async () => {
  const relay = await startRelay({}, { prefix: "hooks-none-" });
  seedFrontend(relay.dir);
  try {
    assert.match(relay.boot, /hook none: bodies unchanged, assets no-store, no push/,
      "the relay says which hooks it has, so a deploy that lost one is visible in the log");

    const token = await bearerFor(relay);
    const auth = { authorization: `Bearer ${token}` };

    // Assets: no-store, which is the only safe fallback. They answer 401 unauthenticated and the relay
    // writes no `vary`, so a publicly cacheable answer would let an edge serve a signed-in 200 to
    // everybody.
    const asset = await fetch(`${relay.base}/app.js`, { headers: auth });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "no-store");
    assert.equal(asset.headers.get("etag"), null, "no validator, because nothing is making one");

    // The page: served, and not stamped, because there is nothing to stamp it.
    const page = await fetch(`${relay.base}/`, { headers: { ...auth, accept: "text/html" } });
    const html = await page.text();
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(/\?v=[0-9a-f]{8}/.test(html), false, "no asset stamps in the markup");

    // Push: the routes are not there, so a shell reads a 404 rather than hanging on a route that exists
    // and never answers.
    const push = await fetch(`${relay.base}/push/devices`, { method: "POST", headers: { ...auth, ...json }, body: "{}" });
    assert.equal(push.status, 404);
  } finally { relay.stop(); }
});

// ---- present: the seam is genuinely wired -----------------------------------------------------

// A gateway that answers /api/<method> with a body of a known size, so a projection's effect on the
// wire is a number rather than a feeling. Every other leg points the relay at a dead port on purpose;
// this is the one leg that needs a live upstream, because the projection hook only fires on a 200.
function startStubGateway() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/api/refuses") { res.writeHead(403, json); return res.end(JSON.stringify({ error: "the command said no" })); }
      res.writeHead(200, json);
      res.end(JSON.stringify({ whole: "x".repeat(4096), asked: req.url, sent: body }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

test("an api-diet module is handed the answer and its bytes are the ones on the wire", async () => {
  const gateway = await startStubGateway();
  const relay = await relayWith({
    // The real module will page an outline. This one just proves the seam: it sees the method, the body
    // the console sent and the upstream bytes, and what it returns is what the console gets.
    "api-diet.mjs": `export function shapeApiAnswer(method, args, headers, bytes) {
      if (method === "boom") throw new Error("a projection that throws");
      return { bytes: JSON.stringify({ projected: method, saw: bytes.length, agent: args?.agentId ?? null,
                                       digest: String(headers?.["x-titan-if-digest"] ?? "") }),
               headers: { "x-titan-projection": method } };
    }\n`,
  }, { SAND_HOST_GATEWAY_URL: gateway.url });
  try {
    assert.match(relay.boot, /hook api-diet/, "the module is loaded and named");
    const token = await bearerFor(relay);
    const auth = { authorization: `Bearer ${token}` };

    const res = await fetch(`${relay.base}/api/getConversationOutline`, {
      method: "POST", headers: { ...auth, ...json, "x-titan-if-digest": "abc123" }, body: JSON.stringify({ agentId: "a1" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-titan-projection"), "getConversationOutline");
    const body = await res.json();
    assert.equal(body.projected, "getConversationOutline");
    assert.ok(body.saw > 4096, `the module saw the whole upstream answer: ${body.saw}`);
    assert.equal(body.agent, "a1", "and the PARSED arguments the console sent, which is what a projection decides on");
    assert.equal(body.digest, "abc123", "and the request's own headers, so a module can read x-titan-if-digest");
    // The number that matters: what reached the console is the projection, not the 4 KiB behind it.
    assert.ok(JSON.stringify(body).length < 200, `and the console got the small one: ${JSON.stringify(body).length} bytes`);

    // A projection that throws must never be the reason a command fails: a console with too much data
    // works and a console with an exception does not.
    const boom = await fetch(`${relay.base}/api/boom`, { method: "POST", headers: { ...auth, ...json }, body: "{}" });
    assert.equal(boom.status, 200);
    assert.ok((await boom.text()).includes("xxxx"), "the whole answer went out instead");
    assert.match(relay.boot + "", /hook api-diet/);

    // A refusal is the gateway's own sentence and is never projected.
    const refused = await fetch(`${relay.base}/api/refuses`, { method: "POST", headers: { ...auth, ...json }, body: "{}" });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("x-titan-projection"), null);
    assert.match(await refused.text(), /the command said no/);
  } finally { relay.stop(); await gateway.stop(); }
});

test("an asset-cache module decides the cache headers, the 304 and the stamping", async () => {
  const relay = await relayWith({
    "asset-cache.mjs": `export function assetPolicy(file, url, req) {
      if (String(req?.headers?.["if-none-match"] ?? "") === '"stub"') return { status: 304, headers: { etag: '"stub"' } };
      return { headers: { "cache-control": "private, max-age=31536000, immutable", etag: '"stub"' } };
    }
    export function stampHtml(html) { return html.replace("<head>", "<head><!-- stamped -->"); }\n`,
  });
  try {
    assert.match(relay.boot, /hook .*asset-cache/);
    const token = await bearerFor(relay);
    const auth = { authorization: `Bearer ${token}` };

    const asset = await fetch(`${relay.base}/app.js`, { headers: auth });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "private, max-age=31536000, immutable",
      "PRIVATE, never public: this route is behind the login and the relay writes no vary");
    assert.equal(asset.headers.get("etag"), '"stub"');

    const again = await fetch(`${relay.base}/app.js`, { headers: { ...auth, "if-none-match": '"stub"' } });
    assert.equal(again.status, 304, "the module owns the 304, because only it knows the validator it wrote");
    assert.equal((await again.text()).length, 0);

    // The avatar route goes through the same policy, which is why nine avatar fetches in one first
    // paint stop being nine full downloads.
    const avatar = await fetch(`${relay.base}/avatars/whatever.png`, { headers: auth });
    assert.ok(avatar.status === 200 || avatar.status >= 400, `a dead gateway answers something: ${avatar.status}`);

    const page = await fetch(`${relay.base}/`, { headers: { ...auth, accept: "text/html" } });
    assert.match(await page.text(), /<!-- stamped -->/,
      "index.html is stamped on the way out, so the file on disk is never edited for a cache policy");
  } finally { relay.stop(); }
});

test("a push-edge module gets the routes and the sweep, and a device bearer is what opens them", async () => {
  const relay = await relayWith({
    "push-edge.mjs": `let started = false;
    export function sweepStart() { started = true; console.log("stub push sweep started"); }
    export async function handle({ req, res, url, sub, t }) {
      if (url.pathname !== "/push/devices") return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ took: url.pathname, method: req.method, tenant: t.slug, sub, started }));
      return true;
    }\n`,
  });
  try {
    assert.match(relay.boot, /hook .*push-edge/);
    assert.match(relay.boot, /stub push sweep started/, "the sweep is armed at boot, beside the mail one");

    const token = await bearerFor(relay);
    const auth = { authorization: `Bearer ${token}` };
    const res = await fetch(`${relay.base}/push/devices`, { method: "POST", headers: { ...auth, ...json }, body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.took, "/push/devices");
    assert.equal(body.tenant, "titanium", "the tenant is resolved before the module is reached");
    assert.equal(body.sub, "", "the instance password names no person, which is the operator");

    // A path the module does not take falls through to the ordinary 404 rather than a 200 that did
    // nothing, which is the difference between a shell that reports a fault and one that waits.
    assert.equal((await fetch(`${relay.base}/push/unknown`, { headers: auth })).status, 404);

    // And no credential at all is the login gate's refusal, not the module's: /push is below the gate.
    const naked = await fetch(`${relay.base}/push/devices`, { method: "POST", headers: json, body: "{}" });
    assert.equal(naked.status, 401);
  } finally { relay.stop(); }
});

test("a module that will not parse is one log line and a fallback, never a dead port", async () => {
  // A syntax error in an optional module must not stop the console coming up. A customer meeting a dead
  // port because a cache policy module would not parse is a worse failure than `no-store`.
  const relay = await relayWith({
    "asset-cache.mjs": "export function assetPolicy( { this is not javascript\n",
    "api-diet.mjs": "throw new Error('this module refuses to start');\n",
  });
  try {
    assert.match(relay.boot, /would not load, so the relay runs without it/);
    assert.match(relay.boot, /hook none: bodies unchanged, assets no-store, no push/);
    const token = await bearerFor(relay);
    const asset = await fetch(`${relay.base}/app.js`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "no-store", "the safe fallback, not the broken module's");
  } finally { relay.stop(); }
});

test("a module whose own create() throws falls back too, rather than taking the boot with it", async () => {
  const relay = await relayWith({
    "push-edge.mjs": "export function create() { throw new Error('no credentials configured'); }\n",
  });
  try {
    assert.match(relay.boot, /a module would not start, so the relay runs without it/);
    const token = await bearerFor(relay);
    const res = await fetch(`${relay.base}/push/devices`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, ...json }, body: "{}",
    });
    assert.equal(res.status, 404, "no push, said as a refusal a shell can read");
  } finally { relay.stop(); }
});

test("a module's create() is handed what it cannot reach for itself", async () => {
  const relay = await relayWith({
    "push-edge.mjs": `export function create(deps) {
      const names = Object.keys(deps).sort().join(",");
      return {
        sweepStart() {},
        async handle({ res, url }) {
          if (url.pathname !== "/push/deps") return false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ names, tenants: deps.tenants().map((one) => one.slug) }));
          return true;
        },
      };
    }\n`,
  });
  try {
    const token = await bearerFor(relay);
    const res = await fetch(`${relay.base}/push/deps`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The contract, named here so a module author reads it from a test rather than from a comment.
    assert.equal(body.names, "contextOf,file,gatewayCall,operatorSlug,ownLikeParent,tenants");
    assert.deepEqual(body.tenants, ["titanium"], "tenants() answers live contexts, not registry rows");
  } finally { relay.stop(); }
});
