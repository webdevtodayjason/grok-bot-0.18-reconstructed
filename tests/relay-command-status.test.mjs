// What the console is told when the box's gateway says no.
//
// The relay used to answer 401 AND 403 from the gateway with one sentence: "the gateway refused
// this relay's token ... SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated." That is right
// for 401, which is the only code the gateway spends on the bearer. It is wrong for 403, which is
// the code a COMMAND uses to refuse on its own terms -- resetOnboarding without SAND_TEST_HOOKS=1
// is the first of them, and a browser Origin, an untrusted Host and a cross-site avatar load are
// the others. Reading the stale-token sentence for one of those sends whoever read it to re-mint a
// token that was never the problem, and throws away the one sentence that says what to do.
//
// Both directions are pinned here, because either one alone passes on the broken version.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { signInAsOperator, startRelay } from "./relay-tenant-support.mjs";

// A gateway that answers /api/<method> with whatever this test needs it to.
function startGateway(answer) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { status, payload } = answer(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function callCommand(gatewayAnswer, method) {
  const gateway = await startGateway(gatewayAnswer);
  const relay = await startRelay({ SAND_HOST_GATEWAY_URL: gateway.url }, { prefix: "relay-status-" });
  try {
    const cookie = await signInAsOperator(relay);
    const res = await fetch(`${relay.base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    return { status: res.status, body: await res.text() };
  } finally {
    relay.stop();
    await gateway.stop();
  }
}

test("a command's own 403 reaches the console as itself, not as a stale token", async () => {
  const answered = await callCommand(
    () => ({ status: 403, payload: { error: "resetOnboarding needs SAND_TEST_HOOKS=1" } }),
    "resetOnboarding");
  assert.equal(answered.status, 403);
  assert.match(answered.body, /resetOnboarding needs SAND_TEST_HOOKS=1/);
  assert.doesNotMatch(answered.body, /SAND_HOST_GATEWAY_TOKEN/);
  assert.doesNotMatch(answered.body, /stale/);
});

test("a 401 is still the deployment fault it always was, and says where to look", async () => {
  const answered = await callCommand(
    () => ({ status: 401, payload: { error: "unauthorized" } }),
    "listAgents");
  assert.equal(answered.status, 502);
  assert.match(answered.body, /SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated/);
  // Signing in again is the thing a person tries first, and it cannot work here.
  assert.match(answered.body, /Signing in again will not help/);
});

test("every other status the gateway gives goes through with its own body", async () => {
  for (const [status, error] of [[409, "This workspace holds Titan and 12 more bots. Remove one to add another."],
    [404, "no such agent"], [503, "the box is starting"]]) {
    const answered = await callCommand(() => ({ status, payload: { error } }), "createAgent");
    assert.equal(answered.status, status);
    assert.match(answered.body, new RegExp(error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
