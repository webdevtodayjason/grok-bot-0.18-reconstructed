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

import {
  RELAY_TOKEN, signInAsOperator, signInAsTenant, startRelay, tenantRow, tenantsFile,
} from "./relay-tenant-support.mjs";

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
