// MARKET-6: one plain sentence per way a connector fails.
//
// What the console showed before this module existed was the box's raw `statusDetail`, which is
// whatever Node threw at the far end of a failed spawn. The strings below are captured, not
// invented: they are the shapes measured on grok-bot-local-vm and the R750 demo box on
// 8 September 2026, down to the npx cache path in the stack. A mapping tested against a described
// failure is a mapping that works until the first real one.
//
// Two rules every sentence keeps, and both are asserted: no tool name and no vendor name, because
// the person reading has not been told what mcp-remote or EventSource is; and no hedge, because
// "this may be temporary" tells an operator to wait instead of to act.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".connector-health-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/mcp/connector-health.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const file = path.join(stage, "connector-health.cjs");
writeFileSync(file, result.outputFiles[0].text, "utf8");
const health = createRequire(import.meta.url)(file);

// Captured on the boxes, verbatim. Shortened only where a stack repeats the same frame.
const CAPTURED = {
  wrongKey:
    "MCP error -32000: Connection closed; stderr: [12345] SseError: SSE error: Non-200 status code (401)\n"
    + "    at EventSource.failConnection_fn (/root/.npm/_npx/705d23756ff7dacc/node_modules/eventsource/dist/index.js:290:20)",
  awaitingSignIn:
    "[19883] Waiting for authorization... open the following URL in your browser:\n"
    + "https://mcp.notion.com/authorize?response_type=code&client_id=...&code_challenge=...",
  goneEndpoint:
    "MCP error -32000: Connection closed; stderr: Error POSTing to endpoint (HTTP 410): Gone",
  notAnEndpoint:
    "MCP error -32000: Connection closed; stderr: Error POSTing to endpoint (HTTP 404): Not Found",
  unreachable:
    "MCP error -32000: Connection closed; stderr: request to https://mcp.example.invalid/mcp failed, "
    + "reason: getaddrinfo ENOTFOUND mcp.example.invalid",
  refusedSocket:
    "MCP error -32000: Connection closed; stderr: connect ECONNREFUSED 10.0.0.7:8080",
  missingPackage:
    "MCP error -32000: Connection closed; stderr: npm error code E404\n"
    + "npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fmcp-serverr - Not found",
};

const BANNED_WORDS = [
  "mcp-remote", "eventsource", "npx", "npm", "sse", "stderr", "-32000",
  "notion", "cursor", "grok bot", "tinyfish", "cloudflare",
];

function assertPlainSentence(sentence) {
  assert.equal(typeof sentence, "string");
  assert.ok(sentence.length > 0, "a state with no sentence is the failure this module exists to stop");
  for (const word of BANNED_WORDS) {
    assert.ok(
      !sentence.toLowerCase().includes(word),
      `"${sentence}" names ${word}, which the person reading it has never been told about`,
    );
  }
  // No hedging. A sentence that says "may be" is a sentence that tells nobody what to do.
  assert.doesNotMatch(sentence, /may be|might be|try again later|possibly/i, sentence);
  assert.match(sentence, /[.!]$/, `"${sentence}" is not a sentence`);
}

test("a wrong key and a missing key are the same 401 and two different sentences", () => {
  const stored = health.describeConnectorHealth({
    status: "error", statusDetail: CAPTURED.wrongKey, hasUnstoredCredential: false,
  });
  assert.equal(stored.state, "refused");
  assert.equal(stored.sentence, "The server refused that key.");
  assertPlainSentence(stored.sentence);

  // The difference is the whole of what the operator does next: fix a key, or type one.
  const unstored = health.describeConnectorHealth({
    status: "error", statusDetail: CAPTURED.wrongKey, hasUnstoredCredential: true,
  });
  assert.equal(unstored.state, "needs-key");
  assert.match(unstored.sentence, /needs its key/);
  assertPlainSentence(unstored.sentence);
});

test("a browser sign-in is said before the sixty-second timeout, not after it", () => {
  const answer = health.describeConnectorHealth({ status: "loading", statusDetail: CAPTURED.awaitingSignIn });
  assert.equal(answer.state, "needs-browser-sign-in");
  assert.match(answer.sentence, /browser/);
  assertPlainSentence(answer.sentence);
  // The authorize URL must not be echoed: it is a live code challenge, and pasting one into chat
  // is the thing the connect card exists to stop.
  assert.ok(!answer.sentence.includes("http"), answer.sentence);
});

// MEASURED on grok-bot-local-vm, 8 September 2026. A server refusing an unfilled bearer answers
// 401 on its MCP endpoint and 404 on the discovery paths the client tries next, and the detail that
// reaches the host is the 404. Reading the code first told an operator whose only mistake was not
// having typed the key yet that their address was dead, which is the exact class of wrong sentence
// this module exists to remove.
test("an unstored key beats every status code, because typing it is what they do next", () => {
  const detail = "MCP error -32000: Connection closed; stderr: Error POSTing to endpoint (HTTP 404): not found";
  assert.equal(
    health.describeConnectorHealth({ status: "error", statusDetail: detail, hasUnstoredCredential: true }).state,
    "needs-key",
  );
  // With the key stored, the same detail is the address problem it looks like.
  assert.equal(
    health.describeConnectorHealth({ status: "error", statusDetail: detail, hasUnstoredCredential: false }).state,
    "not-an-endpoint",
  );
  // But a name that does not resolve is not something a key fixes, so it still wins.
  assert.equal(
    health.describeConnectorHealth({
      status: "error",
      statusDetail: "request to https://mcp.example.invalid/mcp failed, reason: getaddrinfo ENOTFOUND mcp.example.invalid",
      hasUnstoredCredential: true,
    }).state,
    "unreachable",
  );
});

test("404 and 410 are the same fact about the address", () => {
  for (const detail of [CAPTURED.notAnEndpoint, CAPTURED.goneEndpoint]) {
    const answer = health.describeConnectorHealth({ status: "error", statusDetail: detail });
    assert.equal(answer.state, "not-an-endpoint");
    assert.match(answer.sentence, /address/);
    assertPlainSentence(answer.sentence);
  }
});

test("a name that does not resolve and a socket that is refused are both unreachable", () => {
  for (const detail of [CAPTURED.unreachable, CAPTURED.refusedSocket]) {
    const answer = health.describeConnectorHealth({ status: "error", statusDetail: detail });
    assert.equal(answer.state, "unreachable");
    assert.match(answer.sentence, /could not reach/);
    assertPlainSentence(answer.sentence);
  }
});

test("an npm 404 says the package is not published, not that the box is broken", () => {
  const answer = health.describeConnectorHealth({ status: "error", statusDetail: CAPTURED.missingPackage });
  assert.equal(answer.state, "missing-package");
  assert.match(answer.sentence, /not published/);
  assertPlainSentence(answer.sentence);
});

test("a connected server counts its tools, and one tool is singular", () => {
  assert.equal(
    health.describeConnectorHealth({ status: "connected", toolCount: 2 }).sentence,
    "Working. It offers 2 tools.",
  );
  assert.equal(
    health.describeConnectorHealth({ status: "connected", toolCount: 1 }).sentence,
    "Working. It offers 1 tool.",
  );
  assert.equal(health.describeConnectorHealth({ status: "connected", toolCount: 2 }).state, "working");
});

test("a host refusal is repeated as it was written, because it already names the cause", () => {
  const reason = '"shell" is reserved: a secret card\'s connector "shell" means the agent\'s own box shell environment.';
  const answer = health.describeConnectorHealth({ status: "refused", statusDetail: reason });
  assert.equal(answer.state, "refused-by-host");
  assert.equal(answer.sentence, reason);
});

test("nothing yet is 'still connecting', and an unreadable failure says so honestly", () => {
  assert.equal(health.describeConnectorHealth({ status: "loading" }).state, "connecting");
  const opaque = health.describeConnectorHealth({ status: "error", statusDetail: "spawn failed" });
  assert.equal(opaque.state, "failed");
  assertPlainSentence(opaque.sentence);
  // It must not claim to know the cause it could not read.
  assert.match(opaque.sentence, /no reason this box could read/);
});

test("the stopped-bridge sentence says the port and the window are not still held", () => {
  assertPlainSentence(health.CONNECT_TIMEOUT_SENTENCE);
  assert.match(health.CONNECT_TIMEOUT_SENTENCE, /stopped/);
});

test("every state this module can answer with carries a sentence a person can act on", () => {
  const inputs = [
    { status: "connected", toolCount: 0 },
    { status: "loading" },
    { status: "needsAuth" },
    { status: "error", statusDetail: CAPTURED.wrongKey, hasUnstoredCredential: true },
    { status: "error", statusDetail: CAPTURED.wrongKey },
    { status: "error", statusDetail: CAPTURED.awaitingSignIn },
    { status: "error", statusDetail: CAPTURED.notAnEndpoint },
    { status: "error", statusDetail: CAPTURED.unreachable },
    { status: "error", statusDetail: CAPTURED.missingPackage },
    { status: "error", statusDetail: "" },
    { status: "refused", statusDetail: 'That name is reserved and this box will not run a connector under it.' },
  ];
  const seen = new Set();
  for (const input of inputs) {
    const answer = health.describeConnectorHealth(input);
    assertPlainSentence(answer.sentence);
    seen.add(answer.state);
  }
  // Nine of the ten declared states are reachable from a real status; "refused" and "needs-key"
  // both come off the same 401, which is the point of the pair.
  assert.ok(seen.size >= 8, [...seen].join(", "));
});
