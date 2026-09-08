// PROXY-1, the control plane's half: minting a key per customer, revoking it, reporting what it
// spent, and never once putting it somewhere it does not belong.
//
// What this file is really guarding is a single fact, measured on the R750 on 2026-09-08: all three
// boxes held a byte identical box-secrets.json carrying one operator provider key. Everything below
// is about replacing that with a credential that is per box, metered and revocable, and about the
// ways that could go wrong quietly:
//
//   minting twice     a retry that mints a second key leaves the box on the first and the registry
//                     handing out the second, and the symptom is a 401 with nothing in any log
//   the eighth step   demo and richard-avery have all seven of the older steps marked ok, so
//                     anything folded into one of those never runs for them again
//   observe mode      a soft budget produces the number and never the refusal, and a max budget
//                     does both. Shipping the wrong one is either a panel that reads zero or a
//                     customer cut off with no warning
//   a leaked key      a virtual key in an admin answer is a credential on a screen
//   deleting too much the migration's forget step matches on a hash prefix, so it can only ever
//                     remove a value somebody proved they already knew
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  PLAN_MODELS,
  createProxyClient,
  includedModelRows,
  isPlanModel,
  isoDay,
  monthStartDay,
  proxyKeyAlias,
  MCP_SERVERS,
} from "../cp/proxy.mjs";
import {
  ensureProxyKey,
  forgetProxyKey,
  loadConfig,
  provisioningPlan,
  readProxyKey,
  tenantPaths,
} from "../cp/provision.mjs";
import { makeTempRoot } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const SLUG = "acme";

async function withProxy(run, options = {}) {
  const root = await makeTempRoot("cp-proxy-");
  const proxy = await startFakeProxy(options);
  const config = loadConfig({
    CP_SESSION_SECRET: "s".repeat(32),
    CP_ADMIN_TOKEN: "a".repeat(24),
    CP_DATA_DIR: path.join(root, "data"),
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_PROXY_URL: proxy.url,
    CP_PROXY_MASTER_KEY: proxy.masterKey,
    ...(options.env ?? {}),
  });
  // The profile directory a real provisioning run would have made two steps earlier.
  mkdirSync(tenantPaths(SLUG, config).profile, { recursive: true, mode: 0o700 });
  try { await run({ proxy, config, root }); }
  finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
}

// ---- the names that cannot change ---------------------------------------------------------------

test("CP_PROXY_URL means the same thing with or without the /v1 an operator will paste", () => {
  // Measured on the R750 2026-09-08: proxy-install.sh --pin-url writes the value WITH /v1, because
  // that is the address a box is pointed at. The admin calls live at the root and only the chat
  // surface lives under /v1, so a value carrying it once would have sent every mint to
  // /v1/key/generate and pointed every box at /v1/v1. Both spellings now load to the same root.
  const root = "http://titanbot-proxy:4000";
  for (const written of [root, `${root}/`, `${root}/v1`, `${root}/v1/`]) {
    assert.equal(loadConfig({ CP_PROXY_URL: written }).proxyUrl, root, `${written} did not load as the root`);
  }
  // And a host that merely ENDS in something v1-ish is not trimmed by accident.
  assert.equal(loadConfig({ CP_PROXY_URL: "http://proxy-v1:4000" }).proxyUrl, "http://proxy-v1:4000");
});

test("the alias and the plan prefix are what every other piece computes", () => {
  // Derivable from the slug, which is the whole reason this wave adds no column to the store:
  // /key/delete takes aliases, so a handle you can compute is a handle that cannot go stale.
  assert.equal(proxyKeyAlias("richard-avery"), "titanbot-richard-avery");
  assert.equal(isPlanModel("plan-zai"), true);
  // The prefix is how the console tells a row it owns from a row the customer owns, so a customer's
  // own endpoint id must never look like one of ours.
  assert.equal(isPlanModel("zai"), false);
  assert.equal(isPlanModel("my-own-plan-zai"), false);
  for (const id of Object.keys(PLAN_MODELS)) assert.equal(isPlanModel(id), true, `${id} is not a plan model`);
});

test("an included row's id equals its model, so there is one string and not two that can drift", () => {
  const rows = includedModelRows({ models: ["plan-zai", "plan-minimax"], windows: { "plan-zai": 123_456 } });
  for (const row of rows) {
    assert.equal(row.id, row.model, "id and model have to be the same string");
    assert.deepEqual(Object.keys(row).sort(), ["contextWindow", "id", "model", "name", "servedBy"]);
    assert.equal(typeof row.name, "string");
    assert.notEqual(row.servedBy, "", "servedBy is what stops a customer's agent naming a container");
  }
  // The measured window wins over the one written down in cp/proxy.mjs.
  assert.equal(rows[0].contextWindow, 123_456);
  assert.equal(rows[1].contextWindow, PLAN_MODELS["plan-minimax"].contextWindow);
  // Anything that is not a plan model is dropped rather than passed through, because these rows are
  // handed to the relay and rendered as cards a customer can click.
  assert.deepEqual(includedModelRows({ models: ["gpt-4", "plan-zai"] }).map((row) => row.id), ["plan-zai"]);
});

test("the two spend windows are calendar windows in UTC", () => {
  const at = Date.parse("2026-09-08T23:30:00.000Z");
  assert.equal(isoDay(at), "2026-09-08");
  // An allowance is monthly, so the window has to be the calendar month a customer was told about
  // and not a rolling thirty days that never lines up with it.
  assert.equal(monthStartDay(at), "2026-09-01");
  assert.equal(monthStartDay(Date.parse("2026-01-31T00:00:00.000Z")), "2026-01-01");
});

// ---- the client ---------------------------------------------------------------------------------

test("every call answers rather than throwing, and says which setting is missing", async () => {
  // No url at all. This is the ordinary state of every install that has not turned the feature on,
  // including Jason's own console today, so it has to be a sentence and never an exception.
  const off = createProxyClient({ config: loadConfig({}) });
  assert.equal(off.configured, false);
  for (const answer of [
    await off.readiness(),
    await off.models(),
    await off.mintKey({ slug: SLUG }),
    await off.keyInfo("sk-anything"),
    await off.deleteKeyByAlias(SLUG),
    await off.spendReport({ startDay: "2026-09-01", endDay: "2026-09-08" }),
  ]) {
    assert.equal(answer.ok, false);
    assert.match(answer.why, /CP_PROXY_URL/);
  }

  // A url and no master key is the other half, and it names the other setting.
  const half = createProxyClient({ config: loadConfig({ CP_PROXY_URL: "http://titanbot-proxy:4000" }) });
  assert.match((await half.readiness()).why, /CP_PROXY_MASTER_KEY/);

  // A url nothing is listening on. Named as unreachable, not as unconfigured, because those two
  // send an operator to completely different places.
  const dead = createProxyClient({
    config: loadConfig({ CP_PROXY_URL: "http://127.0.0.1:1", CP_PROXY_MASTER_KEY: "sk-x", CP_RELAY_TIMEOUT_MS: "1500" }),
  });
  const answer = await dead.readiness();
  assert.equal(answer.ok, false);
  assert.match(answer.why, /the proxy did not answer/);
});

test("the master key opens the admin routes and nothing else does", async () => {
  await withProxy(async ({ proxy, config }) => {
    const good = createProxyClient({ config });
    assert.equal((await good.readiness()).ok, true);

    const wrong = createProxyClient({ config: { ...config, proxyMasterKey: "sk-not-the-master" } });
    const refused = await wrong.models();
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401);
    assert.match(refused.why, /the proxy answered 401/);
    // And the master key is not in what comes back out, ever.
    assert.equal(JSON.stringify(refused).includes(proxy.masterKey), false);
  });
});

test("only plan models come back, the pool is one name, and the measured context window wins", async () => {
  await withProxy(async ({ config }) => {
    const answer = await createProxyClient({ config }).models();
    assert.equal(answer.ok, true);
    // Two Z.AI entries under one model_name is the pool. It has to arrive here as ONE model, which
    // is also MARKET-5's answer: the second subscription has nowhere to live on the console side
    // and does not need one.
    assert.deepEqual(answer.models.sort(), ["plan-minimax", "plan-zai"]);
    assert.equal(answer.from, "/model/info");
    assert.equal(answer.windows["plan-minimax"], 1_000_000);
  }, { models: [
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-minimax", model_info: { max_input_tokens: 1_000_000 } },
    // The operator's own model, which a customer must never be offered.
    { model_name: "jasons-own-gpt", model_info: {} },
  ] });
});

// ---- minting ------------------------------------------------------------------------------------

test("a key is minted once and read back on every run after that", async () => {
  await withProxy(async ({ proxy, config }) => {
    const first = await ensureProxyKey(SLUG, config, { box: "titanbot-box-svc-acme" });
    assert.equal(first.ok, true);
    assert.equal(first.minted, true);
    assert.equal(first.record.alias, "titanbot-acme");

    // The retry. This is the one that matters: a second mint would leave the box authenticating
    // with the first key and the registry handing out the second.
    const second = await ensureProxyKey(SLUG, config);
    assert.equal(second.ok, true);
    assert.equal(second.minted, false, "a retry minted a second key");
    assert.equal(second.record.key, first.record.key);
    assert.equal(proxy.callsTo("POST /key/generate").length, 1, "the proxy was asked for a second key");

    // And the read on the retry did not even ask the proxy which models it serves, because the
    // answer was written down at mint time.
    assert.equal(proxy.callsTo("GET /model/info").length, 1);
  });
});

test("the key file is 0600 and carries no more than the box and the registry need", async () => {
  await withProxy(async ({ config }) => {
    await ensureProxyKey(SLUG, config);
    const file = tenantPaths(SLUG, config).proxyKeyFile;
    assert.equal(existsSync(file), true);
    // The same mode the gateway token file gets. This one is a live provider credential with a
    // budget attached, so the mode is not decoration.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(parsed).sort(), ["alias", "enforced", "key", "keyId", "mintedAt", "models"]);
    assert.match(parsed.mintedAt, /^\d{4}-\d{2}-\d{2}T/);
    for (const row of parsed.models) assert.equal(row.id, row.model);
  });
});

test("what the mint sends is the tenant's own alias and metadata, and never an enterprise-only tag", async () => {
  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey(SLUG, config, { box: "titanbot-box-svc-acme" });
    const sent = proxy.callsTo("POST /key/generate")[0].body;
    assert.equal(sent.key_alias, "titanbot-acme");
    // Measured at integration 2026-09-08 against docker.litellm.ai/berriai/litellm-database:v1.100.0:
    // a mint carrying `tags` answers 403 "only available for LiteLLM Enterprise users: tags", which
    // would fail the provisioning step outright on the build we actually run. The tenant travels in
    // the alias and the metadata, which is where the spend panel reads it from anyway.
    assert.equal(Object.hasOwn(sent, "tags"), false, "a tag on the mint is a 403 on the open source build");
    assert.deepEqual(sent.metadata, { slug: "acme", box: "titanbot-box-svc-acme" });
    // Without this grant the key sees an EMPTY MCP tool list and a 200 while doing it, so a
    // customer's TinyFish connector reports healthy and offers nothing.
    assert.deepEqual(sent.object_permission, { mcp_servers: [...MCP_SERVERS] });
    assert.deepEqual([...sent.models].sort(), ["plan-minimax", "plan-zai"]);
  });
});

test("observe mode mints a soft budget and enforce mints a hard one", async () => {
  // Observe first, which is what this wave ships. A soft budget by LiteLLM's own definition never
  // fails a request and still produces the number the 80 percent chip reads, so the panel is honest
  // from the first day and nobody is cut off by a switch nobody flipped.
  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey(SLUG, config);
    const sent = proxy.callsTo("POST /key/generate")[0].body;
    assert.equal(sent.soft_budget, 25);
    assert.equal(Object.hasOwn(sent, "max_budget"), false, "observe mode must not mint a budget that refuses");
    assert.equal(readProxyKey(SLUG, config).enforced, false);
  }, { env: { CP_PROXY_ALLOWANCE_USD: "25" } });

  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey(SLUG, config);
    const sent = proxy.callsTo("POST /key/generate")[0].body;
    assert.equal(sent.max_budget, 25);
    assert.equal(Object.hasOwn(sent, "soft_budget"), false);
    assert.equal(sent.rpm_limit, 60);
    assert.equal(readProxyKey(SLUG, config).enforced, true);
  }, { env: { CP_PROXY_ALLOWANCE_USD: "25", CP_PROXY_ENFORCE: "1", CP_PROXY_RPM_LIMIT: "60" } });

  // No allowance set at all sends neither, rather than sending a zero, which LiteLLM would read as
  // a budget of nothing and refuse every request against.
  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey(SLUG, config);
    const sent = proxy.callsTo("POST /key/generate")[0].body;
    assert.equal(Object.hasOwn(sent, "soft_budget"), false);
    assert.equal(Object.hasOwn(sent, "max_budget"), false);
  });
});

test("a rotate deletes the old key by alias before it mints the new one", async () => {
  await withProxy(async ({ proxy, config }) => {
    const first = await ensureProxyKey(SLUG, config);
    const second = await ensureProxyKey(SLUG, config, { force: true });
    assert.equal(second.ok, true);
    assert.notEqual(second.record.key, first.record.key);
    // Order, on the recording stub. A rotate that minted first and deleted second would, for the
    // length of one http call, have two live keys for one customer, and a rotate that deleted by
    // VALUE would leave an orphan the day the file is unreadable.
    const order = proxy.calls.map((call) => call.route).filter((route) => route === "POST /key/delete" || route === "POST /key/generate");
    assert.deepEqual(order, ["POST /key/generate", "POST /key/delete", "POST /key/generate"]);
    assert.deepEqual(proxy.callsTo("POST /key/delete")[0].body, { key_aliases: ["titanbot-acme"] });
    assert.equal(proxy.keyCount(), 1, "the old key is still alive at the proxy after a rotate");
  });
});

test("a mint against a proxy that serves nothing refuses rather than handing out a dead key", async () => {
  await withProxy(async ({ config }) => {
    const answer = await ensureProxyKey(SLUG, config);
    assert.equal(answer.ok, false);
    assert.match(answer.why, /serves no plan models/);
    assert.equal(existsSync(tenantPaths(SLUG, config).proxyKeyFile), false, "a refused mint wrote a file anyway");
  }, { models: [{ model_name: "jasons-own-gpt", model_info: {} }] });
});

test("a mint on a server with no proxy is skipped and named, not failed", async () => {
  const root = await makeTempRoot("cp-proxy-off-");
  try {
    const config = loadConfig({ CP_DATA_DIR: path.join(root, "data"), CP_TENANT_ROOT: path.join(root, "tenants") });
    const answer = await ensureProxyKey(SLUG, config);
    assert.equal(answer.ok, false);
    assert.equal(answer.skipped, true, "an unconfigured server has to be a skip, not a failure");
    assert.match(answer.why, /CP_PROXY_URL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forgetting a key locally removes the file and says whether there was one", async () => {
  await withProxy(async ({ config }) => {
    await ensureProxyKey(SLUG, config);
    assert.equal(forgetProxyKey(SLUG, config), true);
    assert.equal(existsSync(tenantPaths(SLUG, config).proxyKeyFile), false);
    assert.equal(forgetProxyKey(SLUG, config), false, "forgetting twice is not an error");
    assert.equal(readProxyKey(SLUG, config), null);
  });
});

test("a key file somebody has damaged reads as no key rather than as a broken one", async () => {
  await withProxy(async ({ config }) => {
    const file = tenantPaths(SLUG, config).proxyKeyFile;
    writeFileSync(file, "{ this is not json", { mode: 0o600 });
    assert.equal(readProxyKey(SLUG, config), null);
    writeFileSync(file, JSON.stringify({ alias: "titanbot-acme", key: "" }), { mode: 0o600 });
    assert.equal(readProxyKey(SLUG, config), null, "a record with an empty key is not a key");
  });
});

// ---- the eighth step ----------------------------------------------------------------------------

test("proxy-key is its own step in the plan, between envs and start", async () => {
  await withProxy(async ({ config }) => {
    const steps = provisioningPlan({ slug: SLUG, name: "Acme", config }).map((step) => step.name);
    // It HAD to be a new step. demo and richard-avery both have all seven of the others marked ok
    // on the R750, and completedSteps skips a step that is already ok, so anything folded into
    // "secrets" or "envs" would never run again for the two customers who exist.
    assert.deepEqual(steps, ["directories", "secrets", "compose", "service", "envs", "proxy-key", "start", "ready"]);
    const step = provisioningPlan({ slug: SLUG, name: "Acme", config }).find((one) => one.name === "proxy-key");
    const preview = JSON.stringify(step.bodyPreview);
    assert.match(preview, /titanbot-acme/);
    // A dry run is a thing an operator pastes into a ticket, so the preview names where the key
    // goes and never what it is.
    assert.equal(preview.includes("sk-"), false, "the plan preview carried something that looks like a key");
    assert.match(preview, /\(generated\)/);
  });
});

test("with no proxy configured the plan step says so instead of naming a route", async () => {
  const root = await makeTempRoot("cp-proxy-plan-");
  try {
    const config = loadConfig({ CP_TENANT_ROOT: path.join(root, "tenants") });
    const step = provisioningPlan({ slug: SLUG, name: "Acme", config }).find((one) => one.name === "proxy-key");
    assert.equal(step.method, "local");
    assert.match(JSON.stringify(step.bodyPreview), /CP_PROXY_URL is not set/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- spend --------------------------------------------------------------------------------------

test("the enterprise-only report is not what the windows are built on, and its refusal is readable", async () => {
  // MEASURED ON THE R750 2026-09-08 on the build this product runs: /global/spend/report answers
  // 400, "You must be a LiteLLM Enterprise user to use this feature". The whole spend panel was
  // built on it, so every client's two windows came back as a refusal. Worse, the refusal shape is
  // {detail: {error: "<sentence>"}} and the message extractor read past it to the object, so the
  // operator was shown "the proxy answered 400: [object Object]" and the real reason was hidden.
  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey("acme", config);
    const client = createProxyClient({ config });
    proxy.chargeAlias("titanbot-acme", 0.5, 2);
    await client.spendReport({ startDay: monthStartDay(Date.now()), endDay: isoDay(Date.now()) });
    assert.equal(proxy.callsTo("GET /global/spend/report").length, 0, "the enterprise-only report was called");
    assert.equal(proxy.callsTo("GET /spend/logs").length, 1);

    // And if anything does call it, what comes back is a sentence a person can act on.
    const refused = await client.call("GET", "/global/spend/report");
    assert.equal(refused.ok, false);
    assert.match(refused.why, /Enterprise/);
    assert.equal(refused.why.includes("[object Object]"), false, "the refusal rendered as an object again");
  });
});

test("spend lands against the tenant that spent it and against nobody else", async () => {
  await withProxy(async ({ proxy, config }) => {
    await ensureProxyKey("acme", config);
    mkdirSync(tenantPaths("beta", config).profile, { recursive: true, mode: 0o700 });
    await ensureProxyKey("beta", config);

    proxy.chargeAlias("titanbot-acme", 1.25, 3);
    const report = await createProxyClient({ config }).spendReport({ startDay: monthStartDay(Date.now()), endDay: isoDay(Date.now()) });
    assert.equal(report.ok, true);

    const acme = report.keys.find((row) => row.alias === "titanbot-acme");
    assert.equal(acme.dollars, 1.25);
    assert.equal(acme.requests, 3);
    // The neighbour who spent nothing is ABSENT from the report, because it is built from the
    // proxy's per request log and a customer who made no request has no rows. That is not a hole:
    // the log covers the whole window, so absent means zero, and cp/admin.mjs's windowFor writes
    // that zero out rather than leaving it to a default. What would be a real fault is the
    // neighbour appearing with somebody else's money on it.
    assert.equal(report.keys.some((row) => row.alias === "titanbot-beta"), false,
      "a customer who spent nothing was given a row anyway");
    assert.equal(report.keys.length, 1, "the report carried a row nobody spent on");
  });
});

test("a key's own spend counter is what a budget is compared against", async () => {
  await withProxy(async ({ proxy, config }) => {
    const minted = await ensureProxyKey(SLUG, config);
    proxy.chargeAlias("titanbot-acme", 4.5, 2);
    const info = await createProxyClient({ config }).keyInfo(minted.record.key);
    assert.equal(info.ok, true);
    assert.equal(info.spend, 4.5);
    assert.equal(info.alias, "titanbot-acme");
    assert.equal(info.softBudget, 25);
    assert.equal(info.maxBudget, null, "observe mode must not have minted a budget that refuses");
  }, { env: { CP_PROXY_ALLOWANCE_USD: "25" } });
});

// ---- the door, measured the way a box hits it ----------------------------------------------------

test("a tenant's key reaches a plan model and the operator's own key does not", async () => {
  await withProxy(async ({ proxy, config }) => {
    const minted = await ensureProxyKey(SLUG, config);

    const ask = (key, model) => fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    });

    const good = await ask(minted.record.key, "plan-zai");
    assert.equal(good.status, 200, "a tenant's own key could not reach the model its plan includes");

    // THE THING THIS WAVE ENDS. Before it, this key was in every box; after it, a box that presents
    // it is refused, and what is in the box is a credential that belongs to one customer.
    const operator = await ask(proxy.masterKey, "plan-zai");
    assert.equal(operator.status, 401, "the operator's own key still opens inference from a box");

    // And a model the key was not minted for is refused too, which is what keeps a customer off
    // anything the operator has added to the proxy for their own use.
    const elsewhere = await ask(minted.record.key, "jasons-own-gpt");
    assert.equal(elsewhere.status, 400);
  });
});

test("a revoked key stops working and a re-mint starts again", async () => {
  await withProxy(async ({ proxy, config }) => {
    const minted = await ensureProxyKey(SLUG, config);
    const ask = () => fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.record.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "plan-zai", messages: [] }),
    });
    assert.equal((await ask()).status, 200);

    const revoked = await createProxyClient({ config }).deleteKeyByAlias(SLUG);
    assert.equal(revoked.ok, true);
    assert.deepEqual(revoked.deleted, ["titanbot-acme"]);
    // Measured at the PROXY, which is where revocation actually happens. The relay deliberately
    // keeps its last good registry answer, so a relay that has stopped serving a row is not
    // evidence a key was revoked.
    assert.equal((await ask()).status, 401, "a revoked key still reached a model");

    forgetProxyKey(SLUG, config);
    const again = await ensureProxyKey(SLUG, config);
    assert.equal(again.minted, true);
    assert.notEqual(again.record.key, minted.record.key);
  });
});

test("a hard budget that is spent is a refusal the box can turn into a sentence", async () => {
  await withProxy(async ({ proxy, config }) => {
    const minted = await ensureProxyKey(SLUG, config);
    proxy.chargeAlias("titanbot-acme", 5, 0);
    const answer = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.record.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "plan-zai", messages: [] }),
    });
    // 400 with a budget message, which is the shape the box translates into "You have used
    // everything your plan includes this month." No dollars, no alias, no vendor name.
    assert.equal(answer.status, 400);
    assert.match(String((await answer.json()).error.message), /Budget has been exceeded/);
  }, { env: { CP_PROXY_ALLOWANCE_USD: "5", CP_PROXY_ENFORCE: "1" } });
});

test("the pool fails over when one subscription's key is the one that is dead", async () => {
  // Two entries under one model_name is the pool, and the failover is the proxy's own
  // routing_strategy plus num_retries. What the control plane has to get right is narrower and is
  // what is measured here: it mints against ONE name whatever the pool depth, so a dead key drains
  // to the other without anything on this side changing.
  await withProxy(async ({ proxy, config }) => {
    const minted = await ensureProxyKey(SLUG, config);
    assert.deepEqual(minted.record.models.map((row) => row.id), ["plan-zai"]);
    assert.equal(proxy.callsTo("POST /key/generate")[0].body.models.length, 1,
      "two subscriptions under one name have to be minted as one model, not two");
  }, { models: [
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
  ] });
});

test("a proxy that fails one call does not leave a half written key file", async () => {
  await withProxy(async ({ proxy, config }) => {
    proxy.failOnce("POST /key/generate", 500, "the database is not up yet");
    const failed = await ensureProxyKey(SLUG, config);
    assert.equal(failed.ok, false);
    assert.match(failed.why, /the database is not up yet/);
    assert.equal(existsSync(tenantPaths(SLUG, config).proxyKeyFile), false);

    // And the retry that an operator would run next actually works, which is the whole point of a
    // step that can be run twice.
    const retried = await ensureProxyKey(SLUG, config);
    assert.equal(retried.ok, true);
    assert.equal(retried.minted, true);
  });
});
