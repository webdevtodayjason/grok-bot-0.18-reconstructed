import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allowanceRefusal, createAllowanceReader } from "../ui/allowance-edge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the exhausted relay response has the exact 429 JSON shape", () => {
  assert.deepEqual(allowanceRefusal({ cycle: { endsAt: "2026-09-17T00:00:00.000Z", daysLeft: 3 } }), {
    error: "allowance", resetsAt: "2026-09-17T00:00:00.000Z", daysLeft: 3,
  });
});

test("the relay caches one control-plane allowance answer per workspace for 60 seconds", async () => {
  let at = 1_000;
  let calls = 0;
  const read = createAllowanceReader({
    cpUrl: "https://control.invalid", relayToken: "relay-token", now: () => at,
    fetchImpl: async () => ({ ok: true, json: async () => ({ state: "ok", used: ++calls }) }),
  });
  assert.equal((await read("acme")).used, 1);
  assert.equal((await read("acme")).used, 1);
  assert.equal((await read("other")).used, 2);
  at += 60_000;
  assert.equal((await read("acme")).used, 3);
});

test("included model traffic is routed through the tenant-keyed allowance edge", async () => {
  const [relay, plane] = await Promise.all([
    readFile(path.join(root, "ui/server.mjs"), "utf8"),
    readFile(path.join(root, "cp/server.mjs"), "utf8"),
  ]);
  assert.match(plane, /model-proxy\/v1/);
  assert.match(plane, /upstreamBaseUrl/);
  assert.match(relay, /registry\.matchBy\(presented, \(row\) => row\.included\?\.key\)/);
  const edge = relay.slice(relay.indexOf("async function relayIncludedModel"), relay.indexOf("// GET /events"));
  assert.ok(edge.indexOf('state === "exhausted"') < edge.indexOf("await fetch("), "the cap is checked before the upstream model is called");
});
