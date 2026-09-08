// A tenant console must not be able to aim the relay at this server's own network.
//
// Two surfaces make one hole. POST /endpoints saves any base URL the browser sends, and the health
// probe behind GET /endpoints then fetches `<baseUrl>/models` with an Authorization header the same
// browser chose and hands back the status, the latency and the model list. On Jason's own console
// that is a feature: it is his machine and the box next door is a legitimate endpoint. For a
// customer it is a port scanner with a bearer, driven by whoever holds that customer's session.
// Measured from a signed-in tenant session before the guard: the relay answered HTTP 401, the box
// gateway HTTP 404, the host address refused and an off-network address timed out, which is four
// different answers and therefore a working scan of the machine every other customer is on.
//
// TENANT-5 moved what decides this. There is one relay and one console for everybody, so the guard
// can no longer key off "is this process a tenant instance": it keys off whose session THIS request
// carries. The same running relay refuses the customer and accepts the operator, which is what the
// last test here measures and what a per-process flag could never have said.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createServer } from "node:http";
import { statSync } from "node:fs";

import {
  RELAY_TOKEN, signInAsOperator, signInAsTenant, startRelay, tenantRow, tenantsFile,
} from "./relay-tenant-support.mjs";
import { boxStub, includedSet } from "./relay-proxy-support.mjs";

// A console with the operator and one customer on it, with no docker and no control plane: the
// registry comes out of the override file, which is what makes this test need no network.
async function startConsole() {
  const demo = tenantRow("demo");
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { prefix: "relay-endpoints-", pathValue: "/nonexistent" });
  return { relay, demo, tenantCatalog: path.join(demo.state, "endpoints.json") };
}

const save = (relay, cookie, endpoints) => fetch(`${relay.base}/endpoints`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ endpoints }),
});

const row = (baseUrl) => ({ id: "probe", name: "probe", baseUrl, model: "m", apiKey: "a bearer the customer chose" });

test("a tenant cannot save an endpoint that points inside this server's network", async () => {
  const { relay, tenantCatalog } = await startConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");

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

    // Nothing was written by any of that, and nothing was written into the OPERATOR's file either:
    // a customer's save goes to that customer's own state directory. TENANT-5.
    for (const file of [tenantCatalog, relay.catalog]) {
      let written = "";
      try { written = readFileSync(file, "utf8"); } catch { written = ""; }
      assert.equal(written, "", `a refused save must not leave a catalog behind (${file})`);
    }

    // A public address over https is saved, so the guard is a fence and not a wall. A literal
    // address rather than a name, so this test needs no DNS.
    const ok = await save(relay, cookie, [row("https://93.184.216.34/v1")]);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).saved, 1);
    // And it landed in the customer's directory, not in the release directory every console shares.
    assert.match(readFileSync(tenantCatalog, "utf8"), /93\.184\.216\.34/);
    let operatorFile = "";
    try { operatorFile = readFileSync(relay.catalog, "utf8"); } catch { operatorFile = ""; }
    assert.equal(operatorFile, "", "a customer's endpoint must not be written where the operator's goes");
  } finally { relay.stop(); }
});

test("a tenant's health probe does not fetch an address inside this server's network", async () => {
  const { relay, tenantCatalog } = await startConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    // Past the save guard on purpose: a catalog written before this shipped, or by any other path,
    // still must not be probed. This is the half that leaks the scan.
    writeFileSync(tenantCatalog, JSON.stringify({ endpoints: [row("https://192.168.32.1:8000")] }, null, 2));
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

test("the same running console still lets the operator point at the box next door", async () => {
  // The control, and under TENANT-5 it is a sharper one than it was: this is the SAME process that
  // just refused the customer. Without this the tests above would pass on a relay that refused
  // everybody always, which would take the box next door away from the operator who owns the
  // machine.
  const { relay, tenantCatalog } = await startConsole();
  try {
    const operator = await signInAsOperator(relay);
    const res = await save(relay, operator, [row("http://titanbot-box:1340")]);
    assert.equal(res.status, 200, "the operator's own console may point anywhere it can reach");
    assert.equal((await res.json()).saved, 1);
    // It went to the operator's file, and the customer's catalog was not touched by it.
    assert.match(readFileSync(relay.catalog, "utf8"), /titanbot-box:1340/);
    let tenantFile = "";
    try { tenantFile = readFileSync(tenantCatalog, "utf8"); } catch { tenantFile = ""; }
    assert.equal(tenantFile, "", "the operator's save must not reach a customer's catalog");

    // And the customer, on the same relay and the same second, is still refused the same address.
    const cookie = await signInAsTenant(relay, "demo");
    const refused = await save(relay, cookie, [row("http://titanbot-box:1340")]);
    assert.equal(refused.status, 400);
    assert.match(String((await refused.json()).error), /have to start with https:\/\//);
  } finally { relay.stop(); }
});


// ---- PROXY-1: the rows a plan already includes -------------------------------------------------
//
// The included set is the one thing on this surface that a customer neither owns nor can edit, and
// the reason it exists at all is that the copied operator key is leaving their box. Three claims
// hold it up, and each of them is a way the wave could have broken this file instead:
//
//   the guard is not relaxed   http://titanbot-proxy:4000/v1 fails tenantEndpointRefusal twice
//                              over, so the rows never go near endpoints.json and the bypass is a
//                              flag no request body can set;
//   a save still works         the rows are on screen beside the customer's own, so a save sends
//                              them back, and the guard runs over EVERY row in the body;
//   the key never leaves       not in the listing, not in the catalog file, not in a browser.

// A proxy that answers /models and counts how many times it was asked.
function startFakeProxy() {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push({ url: req.url, authorization: String(req.headers.authorization ?? "") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "plan-zai" }, { id: "plan-minimax" }, { id: "plan-qwen" }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    asked,
    stop: () => new Promise((done) => server.close(done)),
  })));
}

// The same console as above, with a real docker-shaped door into the customer's box and one
// included set on the customer's row. The proxy's address is a loopback one on purpose: it is
// exactly the shape tenantEndpointRefusal exists to refuse, so a bypass that leaked would show up
// here as a probe that succeeded rather than as a theory.
async function startPlanConsole() {
  const proxy = await startFakeProxy();
  const demo = tenantRow("demo");
  const stub = boxStub([demo.row.box]);
  const included = includedSet({ baseUrl: proxy.url, key: "sk-virtual-for-demo-only" });
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([{ ...demo.row, included }]),
    ...stub.env,
  }, { prefix: "relay-plan-", pathValue: stub.pathValue });
  return { relay, demo, proxy, stub, included, tenantCatalog: path.join(demo.state, "endpoints.json") };
}

test("the included rows are listed beside the catalog, with no key and one probe for the set", async () => {
  const { relay, proxy, stub } = await startPlanConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    const body = await (await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();

    assert.equal(Array.isArray(body.included), true, `included should be a list, got ${JSON.stringify(body).slice(0, 300)}`);
    assert.equal(body.included.length, 3);
    assert.deepEqual(body.included.map((row) => row.id), ["plan-zai", "plan-minimax", "plan-qwen"]);
    // id EQUALS model. One string, so the two can never drift apart between here and the box.
    for (const row of body.included) assert.equal(row.id, row.model, "id and model are one string");
    for (const row of body.included) assert.match(row.id, /^plan-/, "the prefix is what the drop and the resolve both key on");

    // The key is never in the answer, under any name. The word "included" stands where a value
    // would be, the same way the catalog's own rows say "set".
    assert.equal(JSON.stringify(body).includes("sk-virtual-for-demo-only"), false, "the virtual key must not reach a browser");
    for (const row of body.included) assert.equal(row.apiKey, "included");

    // Three rows, one question: same proxy, same base URL, same key. Three probes here would be
    // three requests to say one thing, and on a page that asks for this list twice per load.
    assert.equal(proxy.asked.length, 1, `three rows should be one probe, saw ${proxy.asked.length}`);
    assert.equal(proxy.asked[0].url, "/v1/models");
    assert.equal(proxy.asked[0].authorization, "Bearer sk-virtual-for-demo-only");
    for (const row of body.included) assert.equal(row.health.reachable, true);

    // Nothing about the included set was written anywhere. It is computed per request.
    assert.deepEqual(body.endpoints, []);
    assert.equal(stub.secretsOf("titanbot-box-demo").SAND_OPENAI_COMPATIBLE_API_KEY, undefined);
  } finally { relay.stop(); await proxy.stop(); }
});

test("a save with the plan rows on screen succeeds, writes the customer's own rows, and writes no plan row", async () => {
  const { relay, proxy, tenantCatalog } = await startPlanConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    const listed = await (await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();

    // Exactly what a browser sends back after the customer edits their own key: their row, plus
    // the three plan rows it was shown. Before the drop this answered 400 -- the guard ran over
    // the plan rows too and refused a save the customer had every right to make.
    const saved = await save(relay, cookie, [
      ...listed.included,
      { id: "mine", name: "my own provider", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: "a key the customer owns" },
    ]);
    const savedBody = await saved.text();
    assert.equal(saved.status, 200, `a save with plan rows on screen was refused: ${savedBody}`);
    assert.equal(JSON.parse(savedBody).saved, 1, "only the customer's own row is written");

    const written = JSON.parse(readFileSync(tenantCatalog, "utf8"));
    assert.deepEqual(written.endpoints.map((row) => row.id), ["mine"]);
    assert.equal(written.endpoints[0].apiKey, "a key the customer owns");
    assert.equal(readFileSync(tenantCatalog, "utf8").includes("plan-"), false, "a plan row must never reach endpoints.json");
    assert.equal(readFileSync(tenantCatalog, "utf8").includes("sk-virtual-for-demo-only"), false, "and neither must the virtual key");
  } finally { relay.stop(); await proxy.stop(); }
});

test("the guard still refuses a private address on a customer's own row, and the included flag is not a way past it", async () => {
  const { relay, proxy, tenantCatalog } = await startPlanConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");

    // The plan rows do not buy an exemption for anything else in the same body.
    const listed = await (await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();
    const refused = await save(relay, cookie, [...listed.included, row("https://192.168.32.1:8000")]);
    assert.equal(refused.status, 400);
    assert.match(String((await refused.json()).error), /inside this server's own network/);

    // And the flag itself is not a password. A row that claims to be included, with an id that is
    // NOT plan- prefixed so the drop does not catch it, is saved without the claim and probed
    // under the guard like anything else. This is the whole safety of the bypass in probe().
    const forged = await save(relay, cookie, [
      { id: "forged", name: "forged", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: "k", included: true, enforced: true },
    ]);
    assert.equal(forged.status, 200);
    const written = JSON.parse(readFileSync(tenantCatalog, "utf8"));
    assert.equal(written.endpoints[0].included, undefined, "a body cannot set the flag that skips the guard");
    assert.equal(written.endpoints[0].enforced, undefined);

    // Proved by behaviour, not only by the file: point the same forged row at a private address
    // and it is refused, which it could not be if the flag had survived the save.
    const again = await save(relay, cookie, [
      { id: "forged", name: "forged", baseUrl: "https://10.4.0.9/v1", model: "m", apiKey: "k", included: true },
    ]);
    assert.equal(again.status, 400);
    assert.match(String((await again.json()).error), /inside this server's own network/);
  } finally { relay.stop(); await proxy.stop(); }
});

test("using an included model writes the six names into the box, at 0600", async () => {
  const { relay, proxy, stub } = await startPlanConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    // Something already in the file, from the other writer: the operator's own box secrets. A
    // switch merges, it does not replace.
    stub.writeSecrets("titanbot-box-demo", { CODERABBIT_API_KEY: "a shell credential" });

    const res = await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "plan-zai" }),
    });
    const raw = await res.text();
    assert.equal(res.status, 200, `switching to a plan row failed: ${raw}`);
    const body = JSON.parse(raw);
    assert.equal(body.using, "Z.AI GLM (included with your plan)");
    assert.equal(body.health.reachable, true);
    assert.equal(JSON.stringify(body).includes("sk-virtual-for-demo-only"), false, "the answer carries no key");

    const secrets = stub.secretsOf("titanbot-box-demo");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_BASE_URL, proxy.url);
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_API_KEY, "sk-virtual-for-demo-only");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_MODEL, "plan-zai");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME, "Z.AI GLM (included with your plan)");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW, "200000");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_SERVED_BY, "Z.AI");
    assert.equal(secrets.CODERABBIT_API_KEY, "a shell credential", "the other credential plane in this file survives");

    // SECRET-3, first half. Measured on the R750 2026-09-08 at 0644 box:box on all three boxes,
    // because this writer was a bare `cat` with no mode while the host's own writer for the same
    // file uses 0o600. The mode below is one a shell actually produced.
    assert.equal(statSync(stub.fileOf("titanbot-box-demo", "box-secrets.json")).mode & 0o777, 0o600);
  } finally { relay.stop(); await proxy.stop(); }
});

test("switching back to a customer's own key takes the plan's wording with it", async () => {
  const { relay, proxy, stub, tenantCatalog } = await startPlanConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "plan-zai" }),
    });
    assert.equal(stub.secretsOf("titanbot-box-demo").SAND_OPENAI_COMPATIBLE_SERVED_BY, "Z.AI");

    // Bringing your own key wins, and a box on its own key must never wear plan wording: SERVED_BY
    // is both what makes Titan name the plan and what turns on the plan-worded refusals.
    writeFileSync(tenantCatalog, JSON.stringify({ endpoints: [
      { id: "mine", name: "my own provider", baseUrl: "https://93.184.216.34/v1", model: "m", apiKey: "a key the customer owns" },
    ] }, null, 2));
    const res = await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "mine" }),
    });
    assert.equal(res.status, 200);
    const secrets = stub.secretsOf("titanbot-box-demo");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_SERVED_BY, undefined, "the plan's name must not outlive the plan");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_API_KEY, "a key the customer owns");
  } finally { relay.stop(); await proxy.stop(); }
});

test("a workspace with no included set sees nothing at all, which is what a single-box install is", async () => {
  const demo = tenantRow("plain");
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { prefix: "relay-plan-off-", pathValue: "/nonexistent" });
  try {
    const cookie = await signInAsTenant(relay, "plain");
    const body = await (await fetch(`${relay.base}/endpoints`, { headers: { cookie, accept: "application/json" } })).json();
    assert.deepEqual(body.included, [], "absent is an empty list, never a section promising something");
    const res = await fetch(`${relay.base}/endpoints/use`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "plan-zai" }),
    });
    // No docker here either, so the refusal is the ordinary one: this console cannot reach a box.
    assert.equal(res.ok, false);
  } finally { relay.stop(); }
});
