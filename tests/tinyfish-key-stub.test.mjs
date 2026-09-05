// CONNECT-3: the stub MCP server the connector gate drives, proved here instead of only in the box.
//
// scripts/verify-connector-plane.mjs --tinyfish-key copies scripts/lib/mcp-bearer-stub.mjs into the
// box and puts an `npx mcp-remote` connector in front of it, so every claim that arm makes about
// credentials rests on this server behaving: no answer without the exact bearer, two named tools
// with it, and the key itself never leaving the process. Those are the claims worth pinning where
// they can be checked in a second without a container, so this test starts the same file locally.
//
// The key here is invented and lives for the length of the test. Nothing in this file reads a real
// one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(repoRoot, "scripts", "lib", "mcp-bearer-stub.mjs");
const KEY = `tf-stub-${Math.random().toString(36).slice(2, 12)}`;

// Everything the process ever said. The leak check at the bottom reads this, so a stub that printed
// its own configuration would fail the suite rather than pass it quietly.
let output = "";
const stub = spawn(process.execPath, [STUB, "--port", "0"], {
  env: { ...process.env, MCP_STUB_KEY: KEY },
  stdio: ["ignore", "pipe", "pipe"],
});
stub.stdout.setEncoding("utf8");
stub.stderr.setEncoding("utf8");
stub.stdout.on("data", (chunk) => { output += chunk; });
stub.stderr.on("data", (chunk) => { output += chunk; });
after(() => { stub.kill("SIGKILL"); });

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the stub never printed a port; it said: ${output.slice(0, 300)}`)), 10_000);
  const check = () => {
    const found = /^listening (\d+)$/m.exec(output);
    if (found == null) return;
    clearTimeout(timer);
    resolve(Number(found[1]));
  };
  stub.stdout.on("data", check);
  stub.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the stub exited with ${code}: ${output.slice(0, 300)}`)); });
  check();
});

// Every body the server sent back, so one assertion at the end can speak for all of them.
const bodies = [];
const post = async (message, authorization) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, wwwAuthenticate: res.headers.get("www-authenticate") };
};

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

test("no Authorization header: 401 with a Bearer challenge, and no key in the answer", async () => {
  const res = await post(LIST);
  assert.equal(res.status, 401);
  assert.match(String(res.wwwAuthenticate), /^Bearer\b/);
  assert.equal(res.text.includes(KEY), false);
  // A 401 that still listed the tools would make the whole gate arm meaningless.
  assert.equal(res.text.includes("fetch_content"), false);
});

test("a wrong or unexpanded bearer is refused the same way", async () => {
  for (const header of ["Bearer", "Bearer ", "Bearer ${TINYFISH_API_KEY}", `Bearer ${KEY}x`, `bearer ${KEY}`, KEY]) {
    const res = await post(LIST, header);
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(header)}`);
  }
});

test("with the bearer: initialize, the initialized notification, and exactly two tools", async () => {
  const authorization = `Bearer ${KEY}`;
  const initialized = await post(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    authorization,
  );
  assert.equal(initialized.status, 200);
  assert.equal(JSON.parse(initialized.text).result.serverInfo.name, "mcp-bearer-stub");

  // A notification carries no id, so the transport expects 202 and an empty body back.
  const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, authorization);
  assert.equal(notified.status, 202);
  assert.equal(notified.text, "");

  const listed = await post(LIST, authorization);
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.text).result.tools.map((tool) => tool.name), ["search", "fetch_content"]);
});

test("tools/call hands the arguments straight back", async () => {
  const called = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "echo-me-back" } } },
    `Bearer ${KEY}`,
  );
  assert.equal(called.status, 200);
  const echoed = JSON.parse(JSON.parse(called.text).result.content[0].text);
  assert.deepEqual(echoed, { tool: "search", arguments: { query: "echo-me-back" } });

  const unknown = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
    `Bearer ${KEY}`,
  );
  assert.equal(JSON.parse(unknown.text).error.code, -32602);
});

test("the key is in no response body and in nothing the stub printed", async () => {
  // Runs last, over every exchange above -- including the ones that carried the correct key in a
  // request header. The claim is about what comes BACK.
  assert.ok(bodies.length >= 8, `expected the earlier cases to have run; saw ${bodies.length} answers`);
  for (const body of bodies) assert.equal(body.includes(KEY), false, `a response body carried the key: ${body.slice(0, 120)}`);
  assert.equal(output.includes(KEY), false, `the stub printed the key: ${output.slice(0, 200)}`);
  assert.match(output.trim(), /^listening \d+$/, `the stub printed more than its port: ${output.slice(0, 200)}`);
});

// GitHub's preset carries three headers that are configuration rather than credentials
// (X-MCP-Toolsets, X-MCP-Tools, X-MCP-Readonly), and they are what decides which tools the operator
// gets. A bridge that dropped them would leave the connector working and the catalogue wrong, which
// "it connected" never catches -- so the gate's --github-key arm makes the stub demand them, and
// this is that demand, checked here rather than only inside the box.
test("MCP_STUB_HEADERS: a request missing or mismatching a required header is refused like a bad bearer", async () => {
  const headers = { "X-MCP-Toolsets": "repos,issues,pull_requests", "X-MCP-Readonly": "true" };
  let said = "";
  const second = spawn(process.execPath, [STUB, "--port", "0"], {
    env: { ...process.env, MCP_STUB_KEY: KEY, MCP_STUB_HEADERS: JSON.stringify(headers) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  second.stdout.setEncoding("utf8");
  second.stderr.setEncoding("utf8");
  second.stdout.on("data", (chunk) => { said += chunk; });
  second.stderr.on("data", (chunk) => { said += chunk; });
  try {
    const secondPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the stub never printed a port; it said: ${said.slice(0, 300)}`)), 10_000);
      const check = () => {
        const found = /^listening (\d+)$/m.exec(said);
        if (found == null) return;
        clearTimeout(timer);
        resolve(Number(found[1]));
      };
      second.stdout.on("data", check);
      second.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the stub exited with ${code}: ${said.slice(0, 300)}`)); });
      check();
    });
    const ask = async (extra) => {
      const res = await fetch(`http://127.0.0.1:${secondPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...extra },
        body: JSON.stringify(LIST),
      });
      return { status: res.status, text: await res.text() };
    };
    assert.equal((await ask({})).status, 401, "the bearer alone was accepted");
    assert.equal((await ask({ "X-MCP-Toolsets": headers["X-MCP-Toolsets"] })).status, 401, "one of the two headers was enough");
    assert.equal((await ask({ ...headers, "X-MCP-Readonly": "false" })).status, 401, "a wrong header value was accepted");
    const all = await ask(headers);
    assert.equal(all.status, 200);
    assert.deepEqual(JSON.parse(all.text).result.tools.map((tool) => tool.name), ["search", "fetch_content"]);
    // Same habit as the bearer: nothing the stub says repeats what arrived.
    assert.equal(said.includes(KEY), false, `the stub printed the key: ${said.slice(0, 200)}`);
  } finally {
    second.kill("SIGKILL");
  }
});
