// CONNECT-3. A dependency-free MCP server over streamable HTTP that answers for exactly one bearer
// token and refuses everything else with a 401 -- the shape TinyFish's own endpoint has, which is
// why the preset passes the key as `Authorization: Bearer <key>` rather than as X-API-Key.
//
// Two callers run the SAME bytes. scripts/verify-connector-plane.mjs --tinyfish-key copies this file
// into the box and starts it there behind an `npx mcp-remote` connector; tests/tinyfish-key-stub.
// test.mjs starts it on this machine and drives it directly. That is the point of it being a file
// rather than a string inside the gate: the unit test's claims about the 401, the tool list and the
// key never appearing in an answer are claims about the server the gate actually drives.
//
//   MCP_STUB_KEY=<key> [MCP_STUB_HEADERS='{"X-Name":"value"}'] [MCP_STUB_SSE=1] node mcp-bearer-stub.mjs --port <port> [--host <bind>]
//
// The key comes from the environment and never from an argument, because a command line is readable
// by anyone who can run ps. It prints one line, "listening <port>", when it is up, and nothing else
// ever -- no request log, no header dump. A stub that logged its inputs would be a stub that logs
// the key it exists to protect.
//
// MCP_STUB_HEADERS is the same demand for headers that are NOT credentials. GitHub's preset carries
// three of them (X-MCP-Toolsets, X-MCP-Tools, X-MCP-Readonly) and they are what decides which tools
// the operator gets; a header the bridge dropped on the floor would leave the connector working and
// the catalogue wrong, which no "it connected" ever catches. With them required here, a connector
// that reaches `connected` has proved every one of them arrived with the value the preset set.
//
// MCP_STUB_SSE=1 serves the OLDER transport instead: `GET /sse` opens the stream and names a POST
// address, and every answer comes back down the stream rather than in the POST's own response. The
// Add-your-own card offers that transport as its second option and nothing had ever driven it, so
// the door was shipped on the assumption that the box would do the right thing with it. There is no
// vendor to point it at either -- the one obvious public candidate answers 410 on its /sse and no
// shipping preset recommends it -- so the thing it gets proved against is this file. Both modes
// answer out of the same `handle()`, deliberately: a difference between them is then a difference
// in transport and cannot be a difference in what the server decided to say.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const PORT = Number(argOf("port") ?? 0);
const HOST = argOf("host") ?? "127.0.0.1";
const KEY = process.env.MCP_STUB_KEY ?? "";
if (KEY.length === 0) {
  process.stderr.write("MCP_STUB_KEY is required\n");
  process.exit(2);
}

// Header name (lowercased, the shape node hands back) to the exact value the request must carry.
// An empty or absent MCP_STUB_HEADERS demands nothing, which is the TinyFish and Linear shape.
let REQUIRED_HEADERS = [];
try {
  const declared = JSON.parse(process.env.MCP_STUB_HEADERS ?? "{}");
  if (declared == null || typeof declared !== "object" || Array.isArray(declared)) throw new Error("not an object");
  REQUIRED_HEADERS = Object.entries(declared).map(([name, value]) => [name.toLowerCase(), String(value)]);
} catch {
  process.stderr.write("MCP_STUB_HEADERS must be a JSON object of header name to value\n");
  process.exit(2);
}

// Two tools, because "exactly these two" is a stronger claim than "at least one": a tool list that
// picked up a stray server would not pass it.
const TOOLS = [
  {
    name: "search",
    description: "Echoes back the arguments it was called with.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "fetch_content",
    description: "Echoes back the arguments it was called with.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  },
];

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });

/** One JSON-RPC message in, one answer out. `null` means "a notification, nothing to answer". */
function handle(message) {
  const id = message?.id;
  const method = message?.method;
  const params = message?.params;
  if (id === undefined || id === null) return null;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-bearer-stub", version: "0.0.1" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((tool) => tool.name === name)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } };
    }
    // The echo IS the assertion the gate makes: arguments that come back reached this process, so
    // the whole path -- connector spawn, mcp-remote, the bearer header, this server -- carried them.
    return reply(id, {
      content: [{ type: "text", text: JSON.stringify({ tool: name, arguments: params?.arguments ?? {} }) }],
      isError: false,
    });
  }
  return reply(id, {});
}

const sendJson = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
};

// Which transport this process is serving. The default is unchanged, so every caller that already
// existed binds and speaks exactly as it did.
const SSE = process.env.MCP_STUB_SSE === "1";
// Open streams by the session id the endpoint event handed out. One entry per connected client, and
// a client that goes away takes its entry with it, so a POST naming a stream nobody holds is a 404
// rather than a write to a dead socket.
const streams = new Map();

/**
 * The credential check, identical on every route of both transports. In the older transport opening
 * the stream and posting a message are two separate requests, and the SDK's own client sends the
 * auth headers on both, so both are checked here: a stub that guarded only the stream would pass a
 * connector whose key never reached the half that carries the work.
 *
 * Returns true when it has already answered and the caller must stop.
 */
const refusedForCredential = (req, res) => {
  // Exact equality, not a prefix and not a trim: an unexpanded "Bearer ${TINYFISH_API_KEY}", a
  // "Bearer" with the variable empty, and a stale key all have to fail the same way.
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    // The realm names the credential, never its value. This line is the only place a client is told
    // WHICH secret is missing, and it has to stay tellable without becoming readable.
    sendJson(res, 401,
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: this server needs an Authorization: Bearer header" } },
      { "www-authenticate": 'Bearer realm="mcp-bearer-stub"' });
    return true;
  }
  // Refused the same way as a missing bearer, and for the same reason: the connector must not reach
  // `connected` on a request that lost one of them. The refusal names the header and never repeats
  // what arrived -- the habit of not echoing an inbound header back is what keeps the bearer out of
  // an answer, and it costs nothing to keep here too.
  const wrongHeader = REQUIRED_HEADERS.find(([name, value]) => req.headers[name] !== value);
  if (wrongHeader !== undefined) {
    sendJson(res, 401,
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: `unauthorized: this server needs the header ${wrongHeader[0]}` } },
      { "www-authenticate": 'Bearer realm="mcp-bearer-stub"' });
    return true;
  }
  return false;
};

const readBody = (req) => new Promise((resolve) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => resolve(body));
});

/**
 * The older transport, the one the Add-your-own card calls "SSE (older; only if the server's docs
 * say so)". `GET /sse` answers with a stream whose first event names the address to POST to, and
 * every answer to those POSTs comes back down that stream rather than in the POST's own response --
 * which is the whole difference from the modern transport, and the reason a client written for one
 * cannot read the other. The session id in that address is what ties the two halves together.
 */
const serveSse = async (req, res, route) => {
  if (route === "/sse" && req.method === "GET") {
    if (refusedForCredential(req, res)) return;
    const sessionId = randomUUID();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    streams.set(sessionId, res);
    res.on("close", () => { streams.delete(sessionId); });
    // Relative on purpose: the client resolves it against the address it dialled, so a stub reached
    // through the box's own private address does not hand back a loopback one it cannot use.
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    return;
  }
  if (route === "/messages" && req.method === "POST") {
    if (refusedForCredential(req, res)) return;
    const sessionId = new URL(String(req.url), "http://stub").searchParams.get("sessionId") ?? "";
    const stream = streams.get(sessionId);
    if (stream === undefined) {
      return sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "no open stream for that session" } });
    }
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    // 202 first and the answer afterwards, in that order. A client that waits for the POST to settle
    // before it reads the stream would deadlock on any other order.
    res.writeHead(202);
    res.end();
    for (const answer of (Array.isArray(parsed) ? parsed : [parsed]).map(handle)) {
      if (answer != null) stream.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    }
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
};

const server = createServer((req, res) => {
  const route = String(req.url ?? "").split("?")[0];
  if (SSE) return void serveSse(req, res, route);
  // Everything but /mcp is a 404, OAuth discovery included. A client that gets a 401 here goes
  // looking for /.well-known/oauth-authorization-server next, and answering that with anything but
  // "there is none" would send it into a sign-in flow this server cannot finish.
  if (route !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  if (refusedForCredential(req, res)) return;
  // No SSE stream to open and no session to end; the streamable HTTP client treats both as fine.
  if (req.method !== "POST") {
    res.writeHead(req.method === "DELETE" ? 200 : 405, { allow: "POST" });
    return res.end();
  }
  void readBody(req).then((body) => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const answers = (Array.isArray(parsed) ? parsed : [parsed]).map(handle).filter((answer) => answer != null);
    // A body that was nothing but notifications gets 202 and an empty response, which is what the
    // streamable HTTP transport expects back from notifications/initialized.
    if (answers.length === 0) { res.writeHead(202); return res.end(); }
    sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0]);
  });
});

// MARKET-6. Loopback stays the default, so every existing caller binds exactly where it did. The
// native-remote arm needs the other option: a connector pointed at 127.0.0.1 is refused at the door
// now, because inside a box that address is the exec daemon on 1337 and 1338 and the host's own
// gateway on 1340. That arm passes the box's own private address here instead, which is still only
// reachable from inside the box's network namespace.
server.listen(PORT, HOST, () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
