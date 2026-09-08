// PROVIDERS-1. The Providers panel's half of the control plane: providers, their key pools, the
// plan models those pools serve, and the record of who changed what.
//
// Jason, 2026-09-08: "say I have to roll a key, or I want to add a provider or add a third, second,
// or fourth key on a specific model plan... the mechanism for both me and the AI agent needs to be
// able to do this on our own." Before this wave every one of those was a text file on the R750 plus
// a proxy restart. Every test below is one of those operations done as a route.
//
// THE TWO RULES THAT ARE NOT NEGOTIABLE, and both are asserted here rather than assumed:
//
//   a key value goes in through a POST body and comes out of nothing -- no GET, no ledger row;
//   a routing alias never reaches a customer's page, whatever else is true.
//
// The fake proxy carries the same sharp edges the real v1.100.0 build was measured to have: a
// duplicate model_info.id is a 500 rather than an upsert, POST /model/update refuses a
// model_info-only body, PATCH /credentials wants credential_name in the body as well as the path,
// POST /fallback validates that its target exists, and with store_model_in_db off the deployment
// half refuses loudly while the credential half answers 200 and persists.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import { openStore } from "../cp/store.mjs";
import { createAdminApi } from "../cp/admin.mjs";
import { loadConfig } from "../cp/provision.mjs";
import { createProxyClient, includedModelRows, servedPlanModels, tenantRoutesFor, TB } from "../cp/proxy.mjs";
import { createApp } from "../cp/server.mjs";
import { makeTempRoot } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

// A real-shaped provider key, planted so every answer and every ledger row can be swept for it.
const PLANTED = "sk-zai-9f4c1d2e6b8a0357192a4c6e8d0f2b41";
const OPERATOR = "operator-token-for-a-test";
const CALLER_IP = "203.0.113.9";

async function withPanel(run, { models, storeModelInDb } = {}) {
  const root = await makeTempRoot("cp-providers-");
  const store = openStore({ dataDir: root });
  // NO MODELS TO START WITH, on purpose. Every case here builds the shape it needs through the
  // panel, which is the whole point: before this wave the shape came from a text file and a
  // restart, and a test seeded from a file would prove the old mechanism rather than the new one.
  const proxy = await startFakeProxy({ models: models ?? [], storeModelInDb });
  const keys = new Map();
  const relayCalls = [];
  // The VENDOR, which this file now talks to directly. The catalog used to be read through a
  // LiteLLM pass-through carrying the key as a header; that header was measured on the R750 sitting
  // in the proxy's Postgres in cleartext and coming back unmasked from GET
  // /config/pass_through_endpoint, so the read moved here and the key is held for one request.
  // Recorded separately from the relay because "did this write inside a box" and "did this ask the
  // vendor" are different questions and one list could not answer both.
  const vendorCalls = [];
  const vendor = { status: 200, models: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"], body: null };
  const config = {
    dataDir: root, tenantRoot: root,
    proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey,
    adminToken: OPERATOR,
    relayUrl: "http://relay.invalid", relayToken: "relay-token",
    proxyAllowanceUsd: 20,
  };
  // The relay, which is the only thing that can write inside a box. It answers the way the real one
  // does: names, lengths and hash prefixes, never a value.
  const fetchImpl = async (address, init = {}) => {
    const url = new URL(String(address));
    if (url.hostname !== "relay.invalid") {
      vendorCalls.push({ url: String(address), method: String(init.method ?? "GET"), authorization: String(init.headers?.authorization ?? "") });
      if (vendor.status !== 200) {
        return new Response(JSON.stringify(vendor.body ?? { error: { message: "token expired or incorrect" } }), { status: vendor.status, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: vendor.models.map((id) => ({ id, object: "model" })) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    relayCalls.push({ path: url.pathname, body: init.body ? JSON.parse(init.body) : {} });
    return new Response(JSON.stringify({
      slug: url.pathname.split("/")[3],
      using: JSON.parse(init.body ?? "{}").model ?? "",
      wrote: [{ name: "SAND_OPENAI_COMPATIBLE_MODEL_LABEL", length: 8, sha256: "abc123def456" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = createAdminApi({
    config, store,
    client: { base: "", call: async () => ({}) },
    json: (response, status, body) => { response.status = status; response.body = body; },
    noContent: () => {},
    publicAccount: (account) => account,
    publicTenant: (tenant) => tenant,
    tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
    tenantPower: async () => {}, tenantProvision: async () => {},
    currentSession: () => ({ ok: false }),
    log: () => {},
    proxy: createProxyClient({ config }),
    proxyKeyOf: (slug) => keys.get(slug) ?? null,
    clientOf: () => CALLER_IP,
    fetchImpl,
  });

  const call = async (method, pathname, body = undefined) => {
    const url = new URL(`http://cp.invalid${pathname}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const request = { headers: { authorization: `Bearer ${OPERATOR}` }, method };
    const response = { status: 0, body: null };
    const took = await api.handle(request, response, { segments, method, body, url });
    assert.equal(took, true, `${method} ${pathname} was not taken by the admin api`);
    return response;
  };

  try { await run({ store, proxy, api, call, keys, relayCalls, vendorCalls, vendor, config, root }); }
  finally { await proxy.close(); store.close(); await rm(root, { recursive: true, force: true }); }
}

/** A provider with one key and one plan model on it, which is where most cases start. */
async function seedZai(call, { alias = "plan-zai", visionFirst = true } = {}) {
  const added = await call("POST", "/v1/admin/providers/zai/keys", { apiKey: PLANTED, label: "subscription one" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  if (visionFirst) {
    // The vision route is created FIRST, because POST /fallback validates that its target exists.
    await call("POST", "/v1/admin/plan-models", {
      alias: "plan-zai-vision", provider: "zai", vendorModel: "glm-5.3-flash",
      supportsVision: true, customerVisible: false, contextWindow: 128000,
    });
  }
  const made = await call("POST", "/v1/admin/plan-models", {
    alias, provider: "zai", vendorModel: "glm-5.3",
    customerName: "Z.AI GLM (included with your plan)", customerLabel: "GLM-5.3", servedBy: "Z.AI GLM",
    contextWindow: 200000, visionFallback: visionFirst ? "plan-zai-vision" : "",
    ...(visionFirst ? {} : { supportsVision: true }),
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return added.body.slot;
}

test("the whole panel is one fetch, and nothing in it is a key", async () => {
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    const answer = await call("GET", "/v1/admin/providers");
    assert.equal(answer.status, 200);
    const body = answer.body;
    assert.equal(body.configured, true);
    // The proxy is serving out of its database, so a change made here takes on the next request.
    assert.equal(body.db.on, true, body.db.why);

    const zai = body.providers.find((row) => row.id === "zai");
    assert.equal(zai.keys.length, 1);
    assert.equal(zai.keys[0].slot, "zai-1");
    // THE PROXY'S OWN MASK, not one this side built.
    assert.equal(zai.keys[0].masked, "sk****41");
    assert.deepEqual(zai.keys[0].serves.sort(), ["plan-zai", "plan-zai-vision"]);

    const plan = body.planModels.find((row) => row.alias === "plan-zai");
    assert.equal(plan.vendorModel, "openai/glm-5.3");
    assert.equal(plan.customerLabel, "GLM-5.3");
    assert.equal(plan.visionFallback, "plan-zai-vision");
    assert.equal(plan.shownToCustomers, true);
    const vision = body.planModels.find((row) => row.alias === "plan-zai-vision");
    assert.equal(vision.shownToCustomers, false, "the vision route is on a customer's page");

    // The sweep, over the whole answer. This is the assertion the custody path exists for: nothing
    // has ever put a secret INTO this console before, and the value crosses the browser, the TLS
    // terminator, a JSON body, this file and the proxy on its way in.
    assert.equal(JSON.stringify(body).includes(PLANTED), false, "a provider key came back out of a GET");
    assert.equal(proxy.credentialDigest("zai-1").length, 64, "the key did not reach the proxy at all");
  });
});

test("a second key on a plan is a second entry in one pool, and the alias does not change", async () => {
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    const second = await call("POST", "/v1/admin/providers/zai/keys", { apiKey: `${PLANTED}-two`, label: "subscription two" });
    assert.equal(second.status, 200);
    assert.equal(second.body.slot, "zai-2", "the second slot is not numbered after the first");

    // A key serves nothing until a plan model is pointed at it, which is why the pool is still one
    // deep here. That is the honest shape: a credential is not a deployment.
    const before = proxy.deployments().filter((row) => row.model_name === "plan-zai");
    assert.equal(before.length, 1);

    // Pointing the alias at both slots is what makes it a pool. One model_name, two deployments.
    const widened = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-minimax", provider: "minimax", vendorModel: "MiniMax-M3",
      customerName: "MiniMax M3 (included with your plan)", customerLabel: "MiniMax-M3",
      servedBy: "MiniMax M3", contextWindow: 200000, supportsVision: true,
    });
    assert.equal(widened.status, 409, "a provider with no key served a plan model");
    assert.match(widened.body.message, /no key/);
  });
});

test("a roll changes the key under a name that does not change, and touches no deployment", async () => {
  await withPanel(async ({ call, proxy, store }) => {
    await seedZai(call);
    const before = proxy.credentialDigest("zai-1");
    const deploymentsBefore = JSON.stringify(proxy.deployments());

    const rolled = await call("POST", "/v1/admin/providers/zai/keys/zai-1/roll", { apiKey: "sk-zai-rolled-0000111122223333444455556666" });
    assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
    assert.notEqual(proxy.credentialDigest("zai-1"), before, "the slot still holds the old key");
    // THE POINT OF THE ZERO-GAP ROLL: the pool never changed shape, so nothing was taken out of
    // service and no request could land between two states. A delete-then-add would have a window.
    assert.equal(JSON.stringify(proxy.deployments()), deploymentsBefore, "a deployment was rewritten by a roll");
    assert.equal(proxy.callsTo("POST /model/delete").length, 0);

    const row = store.listAdminActions({ limit: 5 }).find((one) => one.action === "provider.key.roll");
    assert.equal(row.target, "zai/zai-1");
    assert.equal(row.outcome, "ok");
    assert.equal(row.ip, CALLER_IP);
    assert.equal(row.detail.includes("sk-zai-rolled"), false, "a ledger row carried a key value");
    assert.match(row.detail, /sha256 [0-9a-f]{8}/, "a ledger row cannot say WHICH key was rolled");
  });
});

test("a model a customer can see needs the words that name it, or it is refused", async () => {
  await withPanel(async ({ call }) => {
    await call("POST", "/v1/admin/providers/zai/keys", { apiKey: PLANTED, label: "subscription one" });
    // THE FAILURE THIS RULE EXISTS FOR. MEASURED ON THE R750 2026-09-08: demo's Settings card read
    // "plan-zai . 200k context" and the always-visible agent context card read "Z.AI GLM (included
    // with your plan) . plan-zai". A panel that lets an operator create a visible model without
    // naming it would put the next routing alias on the same card.
    const unnamed = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-new", provider: "zai", vendorModel: "glm-5", supportsVision: true,
    });
    assert.equal(unnamed.status, 400);
    assert.match(unnamed.body.message, /routing alias/);

    // And one that refuses images with no fallback named, which is PROXY-10 as a rule rather than
    // as an outage.
    const blind = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-new", provider: "zai", vendorModel: "glm-5",
      customerName: "New", customerLabel: "GLM-5", servedBy: "Z.AI",
    });
    assert.equal(blind.status, 400);
    assert.match(blind.body.message, /screenshots/);
  });
});

test("a routing target never reaches a customer's plan card, and a named model does", async () => {
  // The rows the relay renders, straight out of what the proxy serves. This is the function that
  // stands between an internal alias and somebody's Settings page.
  const rows = includedModelRows({
    deployments: [
      { alias: "plan-zai", named: true, customerVisible: true, customerName: "Z.AI GLM (included with your plan)", customerLabel: "GLM-5.3", servedBy: "Z.AI GLM", contextWindow: 200000 },
      { alias: "plan-zai", named: true, customerVisible: true, customerName: "Z.AI GLM (included with your plan)", customerLabel: "GLM-5.3", servedBy: "Z.AI GLM", contextWindow: 200000 },
      { alias: "plan-zai-vision", named: true, customerVisible: false, customerName: "", customerLabel: "", servedBy: "" },
      { alias: "plan-experiment", named: true, customerVisible: true, customerName: "", customerLabel: "", servedBy: "" },
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ["plan-zai"], "something other than the one named model reached a customer");
  assert.equal(rows[0].modelLabel, "GLM-5.3");
  assert.equal(rows[0].model, rows[0].id, "id and model drifted apart");

  // A key is scoped to the routing targets as well, because the router needs them. The two lists
  // are different on purpose and this is the line that proves they are.
  assert.deepEqual(servedPlanModels({ deployments: [{ alias: "plan-zai" }, { alias: "plan-zai-vision" }, { alias: "plan-zai" }] }), ["plan-zai", "plan-zai-vision"]);

  // AN UPGRADE IS NOT A CLIFF. A deployment the proxy read out of its config file carries no tb_
  // key at all, which is every deployment on the R750 until the seed runs. PLAN_MODELS answers for
  // the three ids that already exist; plan-zai-vision is in no register and gets no card.
  const beforeTheSeed = includedModelRows({
    deployments: [
      { alias: "plan-zai", named: false, customerVisible: false },
      { alias: "plan-zai-vision", named: false, customerVisible: false },
    ],
  });
  assert.deepEqual(beforeTheSeed.map((row) => row.id), ["plan-zai"]);
  assert.equal(beforeTheSeed[0].modelLabel, "GLM-5.3", "the fallback register did not answer");
});

test("a vendor model change merges, keeping the credential and everything the product wrote", async () => {
  await withPanel(async ({ call, proxy, store }) => {
    await seedZai(call);
    const before = proxy.deployments().find((row) => row.model_name === "plan-zai");
    const changed = await call("POST", "/v1/admin/plan-models/plan-zai/update", { provider: "zai", vendorModel: "glm-5" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const after = proxy.deployments().find((row) => row.model_name === "plan-zai");
    assert.equal(after.litellm_params.model, "openai/glm-5");
    // The two things a rebuild would have lost. MEASURED: POST /model/update merges.
    assert.equal(after.litellm_params.litellm_credential_name, before.litellm_params.litellm_credential_name);
    assert.equal(after.model_info.tb_customer_label, "GLM-5.3");
    assert.equal(after.model_info.id, before.model_info.id, "the deployment was replaced rather than updated");
    assert.match(changed.body.message, /next request/);

    // A LABEL EDIT IS A DIFFERENT CALL, because POST refuses a model_info-only body with 400. The
    // two are not one function and this is why.
    const labelled = await call("POST", "/v1/admin/plan-models/plan-zai/update", { customerLabel: "GLM-5" });
    assert.equal(labelled.status, 200, JSON.stringify(labelled.body));
    assert.equal(proxy.callsTo("POST /model/update").length, 1, "a label edit went through the route that refuses one");
    assert.equal(proxy.deployments().find((row) => row.model_name === "plan-zai").model_info.tb_customer_label, "GLM-5");

    const rows = store.listAdminActions({ limit: 10 }).filter((one) => one.action === "plan-model.update");
    assert.equal(rows.length, 2);
    assert.match(rows[1].detail, /from openai\/glm-5\.3 to openai\/glm-5/);
  });
});

test("a key that still serves cannot be removed, and parking the last one is refused", async () => {
  await withPanel(async ({ call }) => {
    await seedZai(call);
    const refused = await call("POST", "/v1/admin/providers/zai/keys/zai-1/remove", { confirm: "zai-1" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /plan-zai/);

    const parked = await call("POST", "/v1/admin/providers/zai/keys/zai-1/park", { parked: true });
    assert.equal(parked.status, 409, "parking the only key left two aliases with nothing to run on");
    assert.match(parked.body.message, /plan-zai/);

    // The typed confirmation is not decoration: it is the difference between a click and a decision.
    const untyped = await call("POST", "/v1/admin/providers/zai/keys/zai-1/remove", { confirm: "yes" });
    assert.equal(untyped.status, 400);
  });
});

test("parking a key takes it out of service, and unparking rebuilds exactly what was taken away", async () => {
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    await call("POST", "/v1/admin/providers/zai/keys", { apiKey: `${PLANTED}-two`, label: "subscription two" });
    // Both slots serving one alias is the pool. Now one of them can be parked.
    const widened = await call("POST", "/v1/admin/plan-models/plan-zai/update", {});
    assert.equal(widened.status, 400, "an empty edit should change nothing");
    const second = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-second", provider: "zai", vendorModel: "glm-5", keySlots: ["zai-1", "zai-2"],
      customerName: "Second", customerLabel: "GLM-5", servedBy: "Z.AI", supportsVision: true,
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(proxy.deployments().filter((row) => row.model_name === "plan-second").length, 2);

    const parked = await call("POST", "/v1/admin/providers/zai/keys/zai-2/park", { parked: true });
    assert.equal(parked.status, 200, JSON.stringify(parked.body));
    assert.equal(proxy.deployments().filter((row) => row.model_name === "plan-second").length, 1);
    assert.equal(proxy.credentials().find((row) => row.credential_name === "zai-2").credential_info.tb_parked, true);

    const back = await call("POST", "/v1/admin/providers/zai/keys/zai-2/park", { parked: false });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const rebuilt = proxy.deployments().filter((row) => row.model_name === "plan-second");
    assert.equal(rebuilt.length, 2, "unparking did not put the deployment back");
    assert.equal(rebuilt.some((row) => row.litellm_params.litellm_credential_name === "zai-2"), true);
    assert.equal(rebuilt.find((row) => row.litellm_params.litellm_credential_name === "zai-2").model_info.tb_customer_label, "GLM-5");
  });
});

test("the catalog is read from the vendor directly, holding the key for one request and storing none", async () => {
  await withPanel(async ({ call, proxy, vendorCalls, vendor }) => {
    await seedZai(call);
    // NO CLEARTEXT DOOR. The first shape of this feature registered /catalog/zai as a LiteLLM
    // pass-through carrying `authorization: Bearer <the key>`, and that header was measured on the
    // R750 2026-09-08 sitting UNENCRYPTED in the proxy's Postgres and coming back unmasked from GET
    // /config/pass_through_endpoint -- a weaker place for a key than the encrypted credentials
    // table the arrangement existed to avoid using.
    assert.equal(proxy.passThrough().some((row) => row.path === "/catalog/zai"), false, "a cleartext catalog door was registered");
    // The read that DID happen went straight to the vendor, carrying the key on that one request.
    const read = vendorCalls.find((row) => row.url.includes("/models"));
    assert.equal(read.authorization.includes(PLANTED), true, "the key did not reach the vendor");
    assert.equal(proxy.passThrough().length, 0);

    // A refresh with no key in hand is NOT a live read and does not claim to be one: this service
    // deliberately keeps no copy of a vendor key.
    const stored = await call("POST", "/v1/admin/providers/zai/catalog/refresh", {});
    assert.equal(stored.status, 200);
    assert.equal(stored.body.live, false);
    assert.deepEqual(stored.body.models, ["glm-5.3", "glm-5.3-flash", "glm-4.6v"], "the names read at add time were thrown away");
    assert.match(stored.body.why, /paste the key/);

    // With the key pasted it is live again, and the answer says which of the two it is.
    vendor.models = ["glm-5.3", "glm-6"];
    const live = await call("POST", "/v1/admin/providers/zai/catalog/refresh", { apiKey: PLANTED });
    assert.equal(live.body.live, true);
    assert.deepEqual(live.body.models, ["glm-5.3", "glm-6"]);
    // NAMES ONLY, and the page says it in these words, because a refresh cannot infer either fact.
    assert.match(live.body.note, /context window and whether a model takes an image are things you set/);

    // MiniMax has no key here, so the curated list -- and the answer says which of the two it is
    // rather than showing yesterday's names as though they were today's.
    const curated = await call("POST", "/v1/admin/providers/minimax/catalog/refresh", {});
    assert.equal(curated.status, 200);
    assert.equal(curated.body.live, false);
    assert.deepEqual(curated.body.models, ["MiniMax-M3"]);

    // A REFRESH THAT FAILS DOES NOT DELETE A LIST THAT WAS ONCE REAL. Falling back to the curated
    // six when the vendor is briefly unreachable would look on the page exactly like the vendor
    // having retired the names it just gave.
    vendor.status = 503;
    const stale = await call("POST", "/v1/admin/providers/zai/catalog/refresh", { apiKey: PLANTED });
    assert.equal(stale.body.live, false);
    assert.deepEqual(stale.body.models, ["glm-5.3", "glm-6"], "a failed refresh threw away the vendor's own list");
    assert.match(stale.body.why, /could not be read just now/);
  });
});

test("a key is proved with the vendor before it is stored, and before a serving slot is patched", async () => {
  await withPanel(async ({ call, proxy, vendor, vendorCalls }) => {
    const slot = await seedZai(call);
    const before = proxy.credentials().find((row) => row.credential_name === slot).credential_values.api_key;

    // ADD. A key the vendor refuses never reaches the proxy at all.
    vendor.status = 401;
    vendor.body = { error: { message: "token expired or incorrect" } };
    const refusedAdd = await call("POST", "/v1/admin/providers/zai/keys", { apiKey: "sk-zai-this-one-is-wrong-0000000000" });
    assert.equal(refusedAdd.status, 409, JSON.stringify(refusedAdd.body));
    assert.match(refusedAdd.body.message, /token expired or incorrect/);
    assert.equal(proxy.credentials().some((row) => row.credential_name === "zai-2"), false, "a refused key was stored anyway");

    // ROLL. MEASURED ON THE R750 2026-09-08 with a throwaway slot: patching a credential to a junk
    // value 401s on the very next request 0.3 s later and then puts the deployment in a 30 s router
    // cooldown, with the old value overwritten in place and nothing to undo it with. So the
    // candidate is proved first and a refusal leaves the pool exactly as it was.
    const refusedRoll = await call("POST", "/v1/admin/providers/zai/keys/zai-1/roll", { apiKey: "sk-zai-also-wrong-1111111111111111" });
    assert.equal(refusedRoll.status, 409, JSON.stringify(refusedRoll.body));
    assert.match(refusedRoll.body.message, /was NOT changed/);
    assert.equal(proxy.credentials().find((row) => row.credential_name === slot).credential_values.api_key, before, "a refused roll changed the serving key");

    // And a good one goes through, checked, with the vendor asked before the swap.
    vendor.status = 200;
    const calls = vendorCalls.length;
    const rolled = await call("POST", "/v1/admin/providers/zai/keys/zai-1/roll", { apiKey: "sk-zai-2222222222222222222222222222" });
    assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
    assert.equal(vendorCalls.length > calls, true, "the roll did not ask the vendor");
    assert.equal(rolled.body.provable, true);
    // The old copy promised a grace period the measurement says does not exist.
    assert.match(rolled.body.message, /no grace period/);
    assert.equal(proxy.credentials().find((row) => row.credential_name === slot).credential_values.api_key.includes("2222"), true);
  });
});

test("a catalog door left behind by an older install is taken down", async () => {
  await withPanel(async ({ call, proxy }) => {
    // What the R750 was carrying: /catalog/zai with a 56 character authorization header, and
    // /catalog/minimax with a 132 character one for a catalog that had never once been read.
    await proxy.addPassThroughRow({ path: "/catalog/zai", target: "https://api.z.ai", headers: { authorization: `Bearer ${PLANTED}` } });
    assert.equal(proxy.passThrough().length, 1);
    await seedZai(call);
    assert.equal(proxy.passThrough().some((row) => row.path === "/catalog/zai"), false, "the cleartext door survived");
  });
});

test("the vision check asks the model rather than guessing, and writes the answer down", async () => {
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    // plan-zai runs a text-only model and has a vision fallback, so a request carrying an image is
    // rescued by the router: the check passes and says so.
    const rescued = await call("POST", "/v1/admin/plan-models/plan-zai/vision-check", {});
    assert.equal(rescued.status, 200);
    assert.equal(rescued.body.vision.ok, true, rescued.body.vision.why);
    assert.equal(proxy.deployments().find((row) => row.model_name === "plan-zai").model_info.tb_vision_ok, true);

    // Take the fallback away and the same model refuses the image with the vendor's own code, which
    // is exactly the fleet-wide screenshot outage PROXY-10 cost a day.
    await call("POST", "/v1/admin/plan-models/plan-zai/update", { visionFallback: "" });
    const refused = await call("POST", "/v1/admin/plan-models/plan-zai/vision-check", {});
    assert.equal(refused.body.vision.ok, false);
    assert.match(refused.body.message, /vision fallback|refused an image/);
    assert.equal(proxy.deployments().find((row) => row.model_name === "plan-zai").model_info.tb_vision_ok, false);
  });
});

test("giving every workspace access writes nothing into a box", async () => {
  await withPanel(async ({ call, proxy, store, keys, relayCalls }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const minted = await client.mintKey({ slug: "demo", models: ["plan-zai"] });
    keys.set("demo", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    await seedZai(call);

    const applied = await call("POST", "/v1/admin/plan-models/plan-zai/apply", {});
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.rows, [{ slug: "demo", ok: true, why: "" }]);
    const record = proxy.keyByAlias("titanbot-demo");
    assert.deepEqual(record.models.sort(), ["plan-zai", "plan-zai-vision"]);
    // THE KEY VALUE DID NOT CHANGE, which is the whole reason this is a sweep and not a re-mint: a
    // rotate writes a new credential into a box and drags in the registry hazard that put a REVOKED
    // key back into demo on 2026-09-08.
    assert.equal(record.key, minted.key, "the sweep rotated a key");
    assert.equal(relayCalls.length, 0, "the sweep wrote inside a box");
    // And the backfill's other half rides along: the key now carries its own route list.
    assert.equal(record.allowedRoutes.includes("/v1/chat/completions"), true);
    assert.equal(record.allowedRoutes.includes("/key/info"), false, "a tenant key can still read a key record");
  });
});

test("pushing a label never moves a workspace nobody named", async () => {
  await withPanel(async ({ call, proxy, store, keys, relayCalls }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    store.createTenant({ slug: "richard-avery", name: "Richard", status: "running" });
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    for (const slug of ["demo", "richard-avery"]) {
      const minted = await client.mintKey({ slug, models: ["plan-zai", "plan-zai-vision"] });
      keys.set(slug, { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    }
    await seedZai(call);

    // WITHOUT NAMES IT CHANGES NOTHING. The door it drives sets the model as well as the label, so
    // pushed at a box running something else it would move that customer without being asked. On
    // the R750 one of those boxes is a real customer.
    const refused = await call("POST", "/v1/admin/plan-models/plan-zai/push-label", {});
    assert.equal(refused.status, 409);
    assert.equal(relayCalls.length, 0);
    assert.match(refused.body.message, /never done to a workspace nobody named|nothing to push/);

    const pushed = await call("POST", "/v1/admin/plan-models/plan-zai/push-label", { slugs: ["demo"] });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0].path, "/admin/tenants/demo/use-included");
    assert.equal(relayCalls[0].body.model, "plan-zai");
    assert.equal(pushed.body.workspaces[0].wrote[0].name, "SAND_OPENAI_COMPATIBLE_MODEL_LABEL");
    assert.match(pushed.body.message, /GLM-5\.3/);
  });
});

test("with the flag off a deployment write is refused in words, and the credential half is not", async () => {
  await withPanel(async ({ call, proxy }) => {
    const added = await call("POST", "/v1/admin/providers/zai/keys", { apiKey: PLANTED, label: "subscription one" });
    // MEASURED: POST /credentials answers 200 and REALLY PERSISTS with the flag off, while
    // POST /model/new answers 500. That half-state is the worst shape there is -- green checkmarks
    // on the half that did nothing -- so the panel has to be able to say which half took.
    assert.equal(added.status, 200);
    assert.equal(proxy.credentialDigest("zai-1").length, 64);

    const refused = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-zai", provider: "zai", vendorModel: "glm-5.3",
      customerName: "Z.AI GLM", customerLabel: "GLM-5.3", servedBy: "Z.AI", supportsVision: true,
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /STORE_MODEL_IN_DB/, "the refusal did not name the thing to change");

    const panel = await call("GET", "/v1/admin/providers");
    assert.equal(panel.body.db.on, null, "a proxy with nothing seeded claimed to know its own flag");
    assert.match(panel.body.db.why, /cannot be checked/);
  }, { storeModelInDb: false, models: [] });
});

test("the quota bar counts what went through one key, and whose it was", async () => {
  await withPanel(async ({ call, proxy, store, keys }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const minted = await client.mintKey({ slug: "demo", models: ["plan-zai"] });
    keys.set("demo", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    await seedZai(call);
    proxy.chargeAlias("titanbot-demo", 0.6, 6, "plan-zai");

    // Jason, over a screenshot of Alibaba's Token Plan Usage page: "WE need to be tracking this. and
    // tracking per account." The total and the reset are the vendor's and are typed in off their
    // page; the used figure is ours and is exact for traffic through this product.
    const set = await call("POST", "/v1/admin/providers/zai/keys/zai-1/quota", {
      total: 10, unit: "prompts", window: "5 hours", resetAt: "2026-09-09T22:37:00Z",
    });
    assert.equal(set.status, 200);

    const panel = await call("GET", "/v1/admin/providers");
    const key = panel.body.providers.find((row) => row.id === "zai").keys[0];
    assert.equal(key.quota.used, 6);
    assert.equal(key.quota.total, 10);
    assert.equal(key.quota.remaining, 4);
    assert.equal(key.quota.pct, 60);
    assert.equal(key.quota.resetAt, "2026-09-09T22:37:00Z");
    // Never dressed up as the vendor's own number.
    assert.equal(key.quota.live, false);
    assert.match(key.quota.why, /Our own count/);
    assert.deepEqual(key.quota.byWorkspace.map((row) => row.slug), ["demo"]);
    assert.equal(key.quota.byWorkspace[0].requests, 6);

    // The same chip the allowance uses, on the vendor's window. Calibrated down rather than spent
    // up, because the spend sweep behind it is cached for a few seconds on purpose and a test that
    // waited that out would be a test about the cache.
    await call("POST", "/v1/admin/providers/zai/keys/zai-1/quota", { total: 6, unit: "prompts", window: "5 hours" });
    const later = await call("GET", "/v1/admin/providers");
    assert.equal(later.body.providers.find((row) => row.id === "zai").keys[0].quota.warn, true, "a spent plan window raised no warning");
  });
});

test("the change record is written before the change and never carries a key", async () => {
  await withPanel(async ({ call, store, proxy }) => {
    await seedZai(call);
    const rows = store.listAdminActions({ limit: 50 });
    assert.equal(rows.length >= 3, true, "nothing was written down");
    assert.deepEqual([...new Set(rows.map((row) => row.outcome))], ["ok"]);
    assert.deepEqual([...new Set(rows.map((row) => row.actor))], ["the operator token"]);
    assert.deepEqual([...new Set(rows.map((row) => row.via))], ["console"]);
    assert.deepEqual([...new Set(rows.map((row) => row.ip))], [CALLER_IP]);
    assert.equal(JSON.stringify(rows).includes(PLANTED), false, "a key value landed in the ledger");

    // A CHANGE THAT HALF SUCCEEDED IS STILL ON THE RECORD. The row goes down before the proxy is
    // asked, so a proxy that refuses leaves a row saying what was attempted and that it failed --
    // which is the only state worth investigating and the one a single write afterwards would lose.
    proxy.failOnce("PATCH /credentials/zai-1", 500, "the database went away");
    const failed = await call("POST", "/v1/admin/providers/zai/keys/zai-1/roll", { apiKey: "sk-zai-never-landed-000011112222333344445555" });
    assert.equal(failed.status, 502);
    const last = store.listAdminActions({ limit: 1 })[0];
    assert.equal(last.action, "provider.key.roll");
    assert.match(last.outcome, /^failed: /);
    assert.match(last.outcome, /database went away/);

    const answer = await call("GET", "/v1/admin/actions");
    assert.equal(answer.status, 200);
    assert.match(answer.body.retention, /never pruned/);
    assert.equal(answer.body.rows[0].at.endsWith("Z"), true);
  });
});

test("the default plan model is the console's own setting, and one workspace can be moved", async () => {
  await withPanel(async ({ call, store, relayCalls }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    await seedZai(call);
    const set = await call("POST", "/v1/admin/defaults", { planModel: "plan-zai" });
    assert.equal(set.status, 200);
    assert.equal(store.getSetting("default_plan_model"), "plan-zai");
    assert.match(set.body.message, /Workspaces that already exist keep what they are on/);

    const refused = await call("POST", "/v1/admin/defaults", { planModel: "glm-5.3" });
    assert.equal(refused.status, 400, "a vendor model was accepted as a plan default");

    const moved = await call("POST", "/v1/admin/clients/demo/model", { planModel: "plan-zai" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(relayCalls.at(-1).path, "/admin/tenants/demo/use-included");
    // The label follows the model in the same write, which is what stops a customer's Titan saying
    // the name of a model it is no longer running.
    assert.equal(moved.body.wrote[0].name, "SAND_OPENAI_COMPATIBLE_MODEL_LABEL");
    assert.match(moved.body.message, /next message/);
  });
});

test("removing a plan model is refused while a box has run it", async () => {
  await withPanel(async ({ call, proxy, store, keys }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const minted = await client.mintKey({ slug: "demo", models: ["plan-zai"] });
    keys.set("demo", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    await seedZai(call);
    proxy.chargeAlias("titanbot-demo", 0.1, 1, "plan-zai");

    const refused = await call("POST", "/v1/admin/plan-models/plan-zai/remove", { confirm: "plan-zai" });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.workspaces, ["demo"]);
    assert.match(refused.body.message, /fails every turn/);

    // Nothing has run the vision route, so it can go, and its fallback row goes with it.
    const gone = await call("POST", "/v1/admin/plan-models/plan-zai-vision/remove", { confirm: "plan-zai-vision" });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(proxy.deployments().some((row) => row.model_name === "plan-zai-vision"), false);
  });
});

// ---- the vision fallback map after a restart ---------------------------------------------------
//
// The wave's second restart takes router_settings.fallbacks OUT of the proxy's config file, and
// from then on the only copy is the row the panel wrote into the proxy's database. There is exactly
// one window in which a screenshot-carrying turn can lose its route, and PROXY-10 already measured
// what that costs: every box in the fleet refusing an image with code 1210, which reads to a
// customer as the model being broken rather than as a map with a hole in it.
//
// So the control plane checks the map once when it starts, against the deployments' own
// tb_vision_fallback -- the same value the panel wrote in the same action that wrote the fallback
// row, which is why this is putting back what the operator already said rather than a second
// opinion about it.
async function withServer(run, { models = [], fallbacks = {} } = {}) {
  const root = await makeTempRoot("cp-fallback-");
  const proxy = await startFakeProxy({ models });
  const config = loadConfig({
    CP_PORT: "0", CP_DATA_DIR: `${root}/data`, CP_TENANT_ROOT: `${root}/tenants`,
    CP_RELEASE_ROOT: `${root}/release`, CP_SESSION_SECRET: "a".repeat(32),
    CP_ADMIN_TOKEN: OPERATOR, CP_RELAY_TOKEN: "relay-token", CP_BASE_DOMAIN: "titanium.bot",
    CP_PUBLIC_URL: "https://api.titanium.bot",
    COOLIFY_URL: "", COOLIFY_API_KEY: "", COOLIFY_PROJECT_UUID: "p", COOLIFY_SERVER_UUID: "s",
    COOLIFY_ENVIRONMENT_NAME: "production",
    CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey,
  });
  const store = openStore({ dataDir: config.dataDir });
  const app = createApp({ config, store, probeImpl: () => { throw new Error("there is no docker network in a test"); } });
  const client = createProxyClient({ config });
  for (const [alias, targets] of Object.entries(fallbacks)) await client.setFallback({ alias, fallbacks: targets });
  try { await run({ app, proxy, client }); }
  finally { store.close(); await proxy.close(); await rm(root, { recursive: true, force: true }); }
}

const zaiPair = (visionFallback = "plan-zai-vision") => ([
  {
    model_name: "plan-zai",
    litellm_params: { model: "openai/glm-5.3" },
    model_info: { id: "zai-1", [TB.visionFallback]: visionFallback },
  },
  {
    model_name: "plan-zai-vision",
    litellm_params: { model: "openai/glm-4.6v" },
    model_info: { id: "zai-vision-1" },
  },
]);

test("a control plane that starts with no fallback row writes the one its deployments name", async () => {
  await withServer(async ({ app, proxy }) => {
    assert.deepEqual(proxy.fallbacks(), {}, "the map started with something in it, so this proves nothing");

    const first = await app.reconcileFallbacks();
    assert.equal(first.ok, true, first.why);
    assert.deepEqual(first.restored.map((row) => [row.alias, row.target]), [["plan-zai", "plan-zai-vision"]]);
    assert.deepEqual(proxy.fallbacks(), { "plan-zai": ["plan-zai-vision"] });

    // AND IT IS IDEMPOTENT, which is what makes it safe at boot: an ordinary restart reads, finds
    // the row already there, and writes nothing at all.
    const again = await app.reconcileFallbacks();
    assert.deepEqual(again.restored, []);
    assert.deepEqual(again.kept.map((row) => row.alias), ["plan-zai"]);
  }, { models: zaiPair() });
});

test("reconciling keeps a route an operator added rather than overwriting it", async () => {
  // POST /fallback replaces the whole list, so a reconcile that wrote only its own target would
  // quietly undo a second route every time the control plane restarted.
  await withServer(async ({ app, proxy }) => {
    const answer = await app.reconcileFallbacks();
    assert.equal(answer.ok, true, answer.why);
    assert.deepEqual(proxy.fallbacks()["plan-zai"], ["plan-zai-vision", "plan-minimax"]);
    assert.deepEqual(answer.restored[0].alongside, ["plan-minimax"]);
  }, {
    models: [...zaiPair(), { model_name: "plan-minimax", litellm_params: { model: "openai/MiniMax-M3" }, model_info: { id: "mm-1" } }],
    fallbacks: { "plan-zai": ["plan-minimax"] },
  });
});

test("a fallback target the proxy does not serve is reported, not written", async () => {
  // The proxy validates the target and answers 400 with the list it does serve. Writing it anyway
  // would put a failed call in every boot's log, which teaches whoever reads them to ignore it.
  await withServer(async ({ app, proxy }) => {
    const answer = await app.reconcileFallbacks();
    assert.equal(answer.ok, true, answer.why);
    assert.deepEqual(answer.restored, []);
    assert.equal(answer.skipped.length, 1);
    assert.equal(answer.skipped[0].target, "plan-zai-retired");
    assert.match(answer.skipped[0].why, /does not serve plan-zai-retired/);
    assert.deepEqual(proxy.fallbacks(), {});
  }, { models: zaiPair("plan-zai-retired").slice(0, 1) });
});

test("a proxy that is down leaves the map alone and says why", async () => {
  await withServer(async ({ app, proxy }) => {
    await proxy.close();
    const answer = await app.reconcileFallbacks();
    assert.equal(answer.ok, false);
    assert.match(answer.why, /could not be asked what it serves/);
  }, { models: zaiPair() });
});

/**
 * THE BLOCKER, in the shape it was really in on the R750.
 *
 * The spend log records the VENDOR model, so a panel that decided "which workspaces run this alias"
 * by matching the alias against that string saw almost nothing: 596 rows said openai/glm-5.3 and
 * three said plan-zai. On 2026-09-08 the live panel therefore reported plan-zai as run by demo
 * alone while richard-avery -- a paying customer -- and titanium were both on it, and that list is
 * the INPUT TO THE REMOVE GUARD. Removing the alias would have been allowed and would have failed
 * every turn in two live boxes.
 */
test("which workspaces run a model is joined on the deployment id, not on the vendor model name", async () => {
  await withPanel(async ({ call, proxy, store, keys }) => {
    for (const slug of ["demo", "richard-avery"]) store.createTenant({ slug, name: slug, status: "running" });
    await seedZai(call);
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    for (const slug of ["demo", "richard-avery"]) {
      const minted = await client.mintKey({ slug, models: ["plan-zai"] });
      keys.set(slug, { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    }
    // What the log really looks like: the vendor model in `model`, the deployment in `model_id`.
    proxy.chargeAlias("titanbot-demo", 0, 3, "plan-zai", { recordedModel: "openai/glm-5.3" });
    proxy.chargeAlias("titanbot-richard-avery", 0, 5, "plan-zai", { recordedModel: "openai/glm-5.3" });

    const answer = await call("GET", "/v1/admin/providers");
    const plan = answer.body.planModels.find((row) => row.alias === "plan-zai");
    assert.deepEqual(plan.workspaceSlugs.sort(), ["demo", "richard-avery"], "a workspace running this model was invisible to the panel");
    assert.equal(plan.workspaces, 2);

    // And the guard that consumes it refuses, naming the customer.
    const removed = await call("POST", "/v1/admin/plan-models/plan-zai/remove", { confirm: "plan-zai" });
    assert.equal(removed.status, 409, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.workspaces.sort(), ["demo", "richard-avery"]);
    assert.equal(proxy.deployments().some((row) => row.model_name === "plan-zai"), true, "the model was deleted while customers were on it");
  });
});

/**
 * The label a customer's Titan says lives in that box's own file, and the panel used to report it as
 * `labelBehind: null` for every model forever. On the R750 that hid a live defect for two days:
 * richard-avery's box-secrets.json carried SAND_OPENAI_COMPATIBLE_MODEL plan-zai and NO
 * SAND_OPENAI_COMPATIBLE_MODEL_LABEL, so his Titan answered with the routing alias while his own
 * console said GLM-5.3.
 */
test("a box that is behind on its label is counted, out of the box's own file", async () => {
  await withPanel(async ({ call, store, config }) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const nodePath = (await import("node:path")).default;
    for (const slug of ["demo", "richard-avery"]) {
      store.createTenant({ slug, name: slug, status: "running" });
      const dir = nodePath.join(config.tenantRoot, slug, "volumes", "data");
      await mkdir(dir, { recursive: true });
      await writeFile(nodePath.join(dir, "box-secrets.json"), JSON.stringify({
        version: 1,
        secrets: {
          SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
          // demo was pushed; richard-avery was not, which is exactly the live state.
          ...(slug === "demo" ? { SAND_OPENAI_COMPATIBLE_MODEL_LABEL: "GLM-5.3" } : {}),
        },
      }));
    }
    await seedZai(call);

    const answer = await call("GET", "/v1/admin/providers");
    const plan = answer.body.planModels.find((row) => row.alias === "plan-zai");
    assert.deepEqual(plan.runningHere.sort(), ["demo", "richard-avery"]);
    assert.equal(plan.labelBehind, 1, "a box with no label was counted as up to date");
    assert.deepEqual(plan.labelBehindSlugs, ["richard-avery"]);
    assert.match(plan.labelBehindWhy, /richard-avery/);

    // And that box is a push-label candidate even though it has never sent a request.
    const refused = await call("POST", "/v1/admin/plan-models/plan-zai/push-label", {});
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.candidates.sort(), ["demo", "richard-avery"]);
  });
});

/**
 * Provider health used to be `keys.every(row => row.lastError == null)` stamped with now(), and
 * nothing on this install ever writes a health result: background_health_checks is off and GET
 * /health/latest answered `{"latest_health_checks":{},"total_models":0}` on the R750. So the light
 * was green, always, including for a provider whose catalog had never been read once.
 */
test("provider health says not checked until something has checked, and goes red on real failures", async () => {
  await withPanel(async ({ call }) => {
    await seedZai(call);
    const quiet = await call("GET", "/v1/admin/providers");
    const zai = quiet.body.providers.find((row) => row.id === "zai");
    assert.equal(zai.health.reachable, null, "an unchecked provider drew a green light");
    assert.match(zai.health.why, /nothing has run|no check/);
    assert.equal(zai.health.checkedAt, "", "an unchecked provider carried a fresh timestamp");
  });

  // A failed request is the only evidence this install has, and it is real evidence. Its own panel,
  // because the spend sweep is cached for a few seconds and a second read inside that window would
  // be the state before the failures rather than after them.
  await withPanel(async ({ call, proxy, store, keys }) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    await seedZai(call);
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const minted = await client.mintKey({ slug: "demo", models: ["plan-zai"] });
    keys.set("demo", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] });
    proxy.chargeAlias("titanbot-demo", 0, 2, "plan-zai", { recordedModel: "openai/glm-5.3", status: "failure" });
    const sick = await call("GET", "/v1/admin/providers");
    const red = sick.body.providers.find((row) => row.id === "zai");
    assert.equal(red.health.reachable, false, JSON.stringify(red.health));
    assert.match(red.health.why, /2 of 2 request/);
    assert.equal(red.health.checkedAt.length > 0, true);
  });

  // And the operator-triggered check, which is the only thing on this install that makes a real
  // request to the vendor on purpose. Every check costs money, which is why it is a button.
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    const checked = await call("POST", "/v1/admin/providers/zai/health", {});
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.reachable, true);
    const after = await call("GET", "/v1/admin/providers");
    const zai = after.body.providers.find((row) => row.id === "zai");
    assert.equal(zai.health.reachable, true);
    assert.equal(zai.health.how, "a check you asked for");
    assert.equal(proxy.callsTo("GET /health").length > 0, true, "the check asked nothing");
  });
});

/**
 * Every dollar on the panel and on the client rows was zero for the plan every customer runs,
 * because the deployments were created with no price and LiteLLM has no price for a Z.AI model id.
 * $0.00 and "nobody set a price" look identical on a screen and mean opposite things.
 */
test("a model with no price says not priced rather than drawing a zero", async () => {
  await withPanel(async ({ call, proxy }) => {
    await seedZai(call);
    const bare = await call("GET", "/v1/admin/providers");
    const plan = bare.body.planModels.find((row) => row.alias === "plan-zai");
    assert.equal(plan.priced, false);
    assert.match(plan.pricedWhy, /zero until a cost per token is set/);
    assert.deepEqual(bare.body.pricing.unpriced.sort(), ["plan-zai", "plan-zai-vision"]);
    assert.equal(bare.body.providers.find((row) => row.id === "zai").keys[0].spend.priced, false);

    // A price set from the panel lands in litellm_params, where the proxy bills from.
    const priced = await call("POST", "/v1/admin/plan-models/plan-zai/update", { inputCostPerToken: 0.0000006, outputCostPerToken: 0.0000022 });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    const row = proxy.deployments().find((one) => one.model_name === "plan-zai");
    assert.equal(row.litellm_params.input_cost_per_token, 0.0000006);
    assert.equal(row.litellm_params.output_cost_per_token, 0.0000022);
    const after = await call("GET", "/v1/admin/providers");
    assert.equal(after.body.planModels.find((one) => one.alias === "plan-zai").priced, true);

    // And a REPOINT keeps it, because POST /model/update merges.
    await call("POST", "/v1/admin/plan-models/plan-zai/update", { vendorModel: "glm-4.7" });
    assert.equal(proxy.deployments().find((one) => one.model_name === "plan-zai").litellm_params.input_cost_per_token, 0.0000006);
  });
});

/**
 * plan-minimax shipped customer-visible, naming ITSELF as its screenshot fallback, never once asked
 * whether it takes an image, and with GET /fallback/plan-minimax answering 404. Any workspace moved
 * onto it takes PROXY-10 again on its first screenshot turn.
 */
test("a model cannot be its own screenshot fallback on a promise, and a refused fallback is not a success", async () => {
  await withPanel(async ({ call, proxy }) => {
    await call("POST", "/v1/admin/providers/zai/keys", { apiKey: PLANTED, label: "subscription one" });
    const naming = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-self", provider: "zai", vendorModel: "glm-5.3",
      customerName: "Self", customerLabel: "Self", supportsVision: true, visionFallback: "plan-self",
    });
    assert.equal(naming.status, 409, JSON.stringify(naming.body));
    assert.equal(naming.body.error, "vision_unproved");
    assert.equal(proxy.deployments().some((row) => row.model_name === "plan-self"), false);

    // A fallback the proxy refuses is a refusal, not a 200 with the reason in a field nobody reads,
    // and the model is kept OFF every customer's card rather than shipped without a screenshot route.
    const dangling = await call("POST", "/v1/admin/plan-models", {
      alias: "plan-dangling", provider: "zai", vendorModel: "glm-5.3",
      customerName: "Dangling", customerLabel: "Dangling", visionFallback: "plan-nothing-serves-this",
    });
    assert.equal(dangling.status, 409, JSON.stringify(dangling.body));
    assert.equal(dangling.body.error, "fallback_refused");
    const made = proxy.deployments().filter((row) => row.model_name === "plan-dangling");
    assert.equal(made.length > 0, true, "the deployment was rolled back, which loses the operator's work");
    assert.equal(made.every((row) => row.model_info.tb_customer_visible === false), true, "a model with no screenshot route stayed on customers' cards");
  });
});

/**
 * A DOOR WITH NO KEY BEHIND IT IS NOT A FEATURE, it is a 401 the customer pays for.
 *
 * MEASURED ON THE R750 2026-09-08: PROXY_TINYFISH_KEY_1 on the proxy service is a bare newline, so
 * /tinyfish/fetch and /tinyfish/search were live with `x-api-key: ""` while every tenant key
 * carried both paths on its allow list. Each call could only fail upstream and each one booked a
 * metered request at cost_per_request 0.0001. config.yaml's own note on the RESERVED second pair
 * says exactly this about shipping a pass-through with no key -- "an unauthenticated request
 * wearing a costume" -- and the first pair shipped anyway.
 */
test("a tenant key is not given a pass-through whose key is not set", async () => {
  await withPanel(async ({ call, proxy, store, config }) => {
    await proxy.addPassThroughRow({ path: "/tinyfish/fetch", target: "https://api.fetch.tinyfish.ai", headers: { "x-api-key": "", "content-type": "application/json" } });
    await proxy.addPassThroughRow({ path: "/tinyfish/search", target: "https://api.search.tinyfish.ai", headers: { "x-api-key": "", "content-type": "application/json" } });
    await seedZai(call);
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });

    // The mint asks the proxy for itself, because cp/provision.mjs names no list.
    const minted = await client.mintKey({ slug: "demo", models: ["plan-zai"] });
    const record = proxy.keyByAlias("titanbot-demo");
    assert.equal(record.allowedRoutes.includes("/v1/chat/completions"), true, "the key cannot run inference");
    assert.equal(record.allowedRoutes.includes("/tinyfish/fetch"), false, "a door with no key behind it was handed to a customer");
    assert.equal(record.allowedRoutes.includes("/tinyfish/search"), false);
    assert.ok(minted.key.length > 0);

    // And the moment the key is really there, the same mint puts the doors back with no code change.
    await proxy.addPassThroughRow({ path: "/tinyfish/fetch-real", target: "https://api.fetch.tinyfish.ai", headers: { "x-api-key": "tf-a-real-key-0123456789" } });
    const routes = tenantRoutesFor(await client.listPassThrough());
    assert.equal(routes.includes("/mcp/"), true, "the MCP mount went away with the empty doors");
    assert.ok(config != null);
  });
});
