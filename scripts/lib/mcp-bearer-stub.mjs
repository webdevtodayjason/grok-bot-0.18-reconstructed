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
//   MCP_STUB_KEY=<key> [MCP_STUB_HEADERS='{"X-Name":"value"}'] node mcp-bearer-stub.mjs --port <port>
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
import { createServer } from "node:http";

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const PORT = Number(argOf("port") ?? 0);
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

const server = createServer((req, res) => {
  const route = String(req.url ?? "").split("?")[0];
  // Everything but /mcp is a 404, OAuth discovery included. A client that gets a 401 here goes
  // looking for /.well-known/oauth-authorization-server next, and answering that with anything but
  // "there is none" would send it into a sign-in flow this server cannot finish.
  if (route !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  // Exact equality, not a prefix and not a trim: an unexpanded "Bearer ${TINYFISH_API_KEY}", a
  // "Bearer" with the variable empty, and a stale key all have to fail the same way.
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    // The realm names the credential, never its value. This line is the only place a client is told
    // WHICH secret is missing, and it has to stay tellable without becoming readable.
    return sendJson(res, 401,
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: this server needs an Authorization: Bearer header" } },
      { "www-authenticate": 'Bearer realm="mcp-bearer-stub"' });
  }
  // Refused the same way as a missing bearer, and for the same reason: the connector must not reach
  // `connected` on a request that lost one of them. The refusal names the header and never repeats
  // what arrived -- the habit of not echoing an inbound header back is what keeps the bearer out of
  // an answer, and it costs nothing to keep here too.
  const wrongHeader = REQUIRED_HEADERS.find(([name, value]) => req.headers[name] !== value);
  if (wrongHeader !== undefined) {
    return sendJson(res, 401,
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: `unauthorized: this server needs the header ${wrongHeader[0]}` } },
      { "www-authenticate": 'Bearer realm="mcp-bearer-stub"' });
  }
  // No SSE stream to open and no session to end; the streamable HTTP client treats both as fine.
  if (req.method !== "POST") {
    res.writeHead(req.method === "DELETE" ? 200 : 405, { allow: "POST" });
    return res.end();
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
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

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
