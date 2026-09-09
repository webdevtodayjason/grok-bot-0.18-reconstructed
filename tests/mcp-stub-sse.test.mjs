// MARKET-6. The older SSE transport, driven rather than assumed.
//
// The Add-your-own card offers two transports and calls the second one "SSE (older; only if the
// server's docs say so)". Nothing had ever opened that door. There is no vendor to open it against
// either: no shipping preset recommends SSE, and the one obvious public candidate answers 410 on
// its /sse, so a gate written against a vendor would be measuring the vendor's retirement schedule
// rather than this box. So the thing it gets proved against is a server this repo owns, and this
// file is where the server's half of that is pinned.
//
// The shape asserted here is the one the MCP TypeScript SDK's own SSEServerTransport writes: a GET
// answered with text/event-stream whose FIRST event is `endpoint` naming a POST address carrying a
// session id, every JSON-RPC answer arriving on the stream rather than in the POST's own response,
// and the POST itself settling 202. A client written for the modern transport cannot read any of
// that, which is exactly why a door offering it needs its own proof.
//
// The strongest claim in the file is the last one: the two transports hand back the SAME answers,
// byte for byte, because both modes answer out of one `handle()`. A difference between them is then
// a difference in transport and cannot be a difference in what the server decided to say.
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
const KEY = `sse-stub-${Math.random().toString(36).slice(2, 12)}`;

/** Starts the stub and resolves the port it printed, keeping everything it ever said. */
async function startStub(env) {
  const said = { text: "" };
  const child = spawn(process.execPath, [STUB, "--port", "0"], {
    env: { ...process.env, MCP_STUB_KEY: KEY, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { said.text += chunk; });
  child.stderr.on("data", (chunk) => { said.text += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the stub never printed a port; it said: ${said.text.slice(0, 300)}`)), 10_000);
    const check = () => {
      const found = /^listening (\d+)$/m.exec(said.text);
      if (found == null) return;
      clearTimeout(timer);
      resolve(Number(found[1]));
    };
    child.stdout.on("data", check);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the stub exited with ${code}: ${said.text.slice(0, 300)}`)); });
    check();
  });
  return { child, said, base: `http://127.0.0.1:${port}` };
}

const sse = await startStub({ MCP_STUB_SSE: "1" });
const http = await startStub({});
after(() => { sse.child.kill("SIGKILL"); http.child.kill("SIGKILL"); });

/**
 * One open SSE stream, with its events parsed off the wire as they arrive. A test that polled the
 * socket itself would be testing its own parser, so the framing is done once, here.
 */
async function openStream(base, authorization) {
  const res = await fetch(`${base}/sse`, { headers: { accept: "text/event-stream", ...(authorization === undefined ? {} : { authorization }) } });
  if (res.status !== 200) return { status: res.status, text: await res.text(), wwwAuthenticate: res.headers.get("www-authenticate"), events: [] };
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          events.push({ event: /^event: (.*)$/m.exec(frame)?.[1], data: /^data: (.*)$/m.exec(frame)?.[1] });
        }
      }
    } catch { /* the stream closes when the test ends */ }
  })();
  const waitFor = async (count) => {
    for (let n = 0; n < 200 && events.length < count; n += 1) await new Promise((r) => setTimeout(r, 25));
    return events;
  };
  await waitFor(1);
  return { status: res.status, contentType: res.headers.get("content-type"), events, waitFor, cancel: () => reader.cancel().catch(() => {}) };
}

test("the stream itself needs the bearer, and a refusal carries neither the tools nor the key", async () => {
  const refused = await openStream(sse.base, undefined);
  assert.equal(refused.status, 401);
  assert.match(String(refused.wwwAuthenticate), /^Bearer\b/);
  assert.equal(refused.text.includes(KEY), false);
  assert.equal(refused.text.includes("fetch_content"), false);
  for (const header of ["Bearer", "Bearer ${TINYFISH_API_KEY}", `Bearer ${KEY}x`, KEY]) {
    assert.equal((await openStream(sse.base, header)).status, 401, `expected 401 for ${JSON.stringify(header)}`);
  }
});

test("with the bearer the first event is `endpoint` and it names a POST address with a session", async () => {
  const stream = await openStream(sse.base, `Bearer ${KEY}`);
  try {
    assert.equal(stream.status, 200);
    assert.match(String(stream.contentType), /^text\/event-stream/);
    assert.equal(stream.events[0].event, "endpoint");
    // Relative, so a client resolves it against the address it dialled. An absolute loopback address
    // here is unreachable from anywhere but the machine the stub is on, which is the one shape a box
    // reaching a stub on its own private address could not use.
    assert.match(String(stream.events[0].data), /^\/messages\?sessionId=[0-9a-f-]{36}$/);
  } finally { stream.cancel(); }
});

test("a message posted to that address is accepted 202 and its answer arrives on the stream", async () => {
  const stream = await openStream(sse.base, `Bearer ${KEY}`);
  try {
    const post = new URL(stream.events[0].data, sse.base);
    // `null` means "send no Authorization header at all". A default parameter cannot say that --
    // passing undefined would take the default and quietly send the key, which is how a test for a
    // missing credential ends up proving nothing.
    const send = async (message, authorization = `Bearer ${KEY}`) => {
      const res = await fetch(post, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
        body: JSON.stringify(message),
      });
      return { status: res.status, text: await res.text() };
    };

    const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    assert.equal(initialized.status, 202);
    // The POST's own body carries nothing. A client reading the answer out of it would hang here,
    // and that is the difference this whole door turns on.
    assert.equal(initialized.text, "");
    await stream.waitFor(2);
    assert.equal(stream.events[1].event, "message");
    assert.equal(JSON.parse(stream.events[1].data).result.serverInfo.name, "mcp-bearer-stub");

    // A notification has no id and so has no answer: the POST settles and the stream stays quiet.
    assert.equal((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(stream.events.length, 2, "a notification produced an event on the stream");

    assert.equal((await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 202);
    await stream.waitFor(3);
    assert.deepEqual(JSON.parse(stream.events[2].data).result.tools.map((tool) => tool.name), ["search", "fetch_content"]);

    assert.equal((await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "echo-me-back" } } })).status, 202);
    await stream.waitFor(4);
    assert.deepEqual(
      JSON.parse(JSON.parse(stream.events[3].data).result.content[0].text),
      { tool: "search", arguments: { query: "echo-me-back" } },
    );

    // The half that carries the work is guarded too. A stub that checked only the stream would pass
    // a connector whose key reached the handshake and nothing after it.
    assert.equal((await send({ jsonrpc: "2.0", id: 4, method: "tools/list" }, null)).status, 401);
    assert.equal((await send({ jsonrpc: "2.0", id: 5, method: "tools/list" }, `Bearer ${KEY}x`)).status, 401);
  } finally { stream.cancel(); }
});

test("a post naming a session nobody holds is refused rather than written to a dead socket", async () => {
  const res = await fetch(`${sse.base}/messages?sessionId=00000000-0000-4000-8000-000000000000`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text.includes("fetch_content"), false);
  assert.equal(text.includes(KEY), false);
});

test("neither mode quietly serves the other one's route", async () => {
  // A door that fell back would let a connector configured for one transport connect over the other
  // and report success, which is precisely the confusion the picker exists to prevent.
  const wrongRouteOnSse = await fetch(`${sse.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(wrongRouteOnSse.status, 404);
  const wrongRouteOnHttp = await fetch(`${http.base}/sse`, { headers: { accept: "text/event-stream", authorization: `Bearer ${KEY}` } });
  assert.equal(wrongRouteOnHttp.status, 404);
});

test("both transports hand back the same answers, so a difference between them is transport only", async () => {
  const stream = await openStream(sse.base, `Bearer ${KEY}`);
  try {
    const post = new URL(stream.events[0].data, sse.base);
    const asked = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "same" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
    ];
    const overSse = [];
    for (const message of asked) {
      const before = stream.events.length;
      await fetch(post, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(message) });
      await stream.waitFor(before + 1);
      overSse.push(JSON.parse(stream.events[before].data));
    }
    const overHttp = [];
    for (const message of asked) {
      const res = await fetch(`${http.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(message) });
      overHttp.push(JSON.parse(await res.text()));
    }
    assert.deepEqual(overSse, overHttp);
  } finally { stream.cancel(); }
});

test("the key is in nothing either stub printed", async () => {
  // Runs last, over every exchange above, including the ones that carried the correct key.
  for (const stub of [sse, http]) {
    assert.equal(stub.said.text.includes(KEY), false, `the stub printed the key: ${stub.said.text.slice(0, 200)}`);
    assert.match(stub.said.text.trim(), /^listening \d+$/, `the stub printed more than its port: ${stub.said.text.slice(0, 200)}`);
  }
});
