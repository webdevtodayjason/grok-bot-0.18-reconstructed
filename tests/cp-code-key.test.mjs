// The per-task credential and the hidden coding deployment (CODE-1, docs/CODE.md).
//
// This half of the wave owns the only thing in the product that can spend the operator's own
// subscriptions on a customer's behalf with no box in the loop, so the claims worth a test are the
// ones that are invisible when they are wrong:
//
//   the MINT BODY, pinned field by field. allowed_routes carries /v1/messages and
//   /v1/messages/count_tokens -- which is the whole reason a task key exists rather than the box's
//   key being reused -- and it carries them on THIS key and nowhere else;
//
//   TENANT_ALLOWED_ROUTES asserted UNCHANGED, because the one-line edit that would make a coding
//   task work without any of this is adding those two paths to the tenant list, and that hands every
//   box on the bridge an Anthropic door on the operator's own plan;
//
//   max_budget and NEVER soft_budget, whatever CP_PROXY_ENFORCE says. LiteLLM's own definition of a
//   soft budget is one that never fails a request, so an observe-mode cap produces a number and stops
//   nothing, and the runaway coding agent this cap exists for would run to the end of the plan;
//
//   the ALIAS SHAPE, because cp/proxy.mjs revokes a tenant by posting `titanbot-<slug>`, and a task
//   key wearing that string would be taken down by a tenant revoke -- or would take the customer's
//   own box key down when the task ended;
//
//   and the DEPLOYMENT, which carries a vendor prefix that looks like a typo and is not: declared
//   openai/ the Anthropic surface answers 200 with an error body inside it, and nothing goes red.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomBytes } from "node:crypto";

import { openStore } from "../cp/store.mjs";
import { createProxyClient, TENANT_ALLOWED_ROUTES, proxyKeyAlias } from "../cp/proxy.mjs";
import {
  CODE_E2B_KEY_SETTING,
  CODE_TASK_ROUTES,
  CODING_ALIAS,
  CODING_SOURCE_ALIAS,
  CODING_VENDOR_PREFIX,
  codeTaskKeyAlias,
  createCodeTasks,
} from "../cp/code.mjs";

const memory = () => openStore({ file: ":memory:" });

/**
 * A proxy that is not a proxy, for the four routes this file's subject uses.
 *
 * It is a real http server on a real port rather than an injected fetch, the same decision
 * tests/cp-proxy-support.mjs makes and for the same reason: what has to be measured is the request
 * that goes on the wire. Its own, rather than that file's, because /key/list is not on that one and
 * this wave does not edit another wave's fixture.
 */
async function startKeyProxy(options = {}) {
  const masterKey = options.masterKey ?? `sk-master-${randomBytes(8).toString("hex")}`;
  const calls = [];
  const keys = new Map();
  const byAlias = new Map();
  let deployments = [...(options.deployments ?? [])];
  let minted = 0;
  let refuseMint = options.refuseMint === true;
  let refuseInfo = options.refuseInfo === true;
  let refuseDelete = options.refuseDelete === true;
  let refuseList = options.refuseList === true;
  // Whether /key/info answers to the HASHED handle as well as to the key value. The real build's
  // behaviour is measured by the gate; both are exercised here so the fallback read is not a story.
  let infoTakesHash = options.infoTakesHash !== false;

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://fake-proxy.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const route = `${request.method} ${url.pathname}`;
      const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      calls.push({ route, body, query: Object.fromEntries(url.searchParams), authorized: presented === masterKey });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (presented !== masterKey) return send(401, { error: { message: "Authentication Error, invalid master key" } });

      if (route === "POST /key/generate") {
        if (refuseMint) return send(500, { error: { message: "the key database is unavailable" } });
        minted += 1;
        const value = `sk-task-${minted}-${randomBytes(4).toString("hex")}`;
        const record = {
          key: value,
          keyId: `hashed-${minted}`,
          alias: String(body?.key_alias ?? ""),
          models: Array.isArray(body?.models) ? body.models.map(String) : [],
          allowedRoutes: Array.isArray(body?.allowed_routes) ? body.allowed_routes.map(String) : [],
          maxBudget: body?.max_budget ?? null,
          softBudget: body?.soft_budget ?? null,
          metadata: body?.metadata ?? {},
          objectPermission: body?.object_permission ?? null,
          spend: 0,
        };
        keys.set(value, record);
        if (record.alias) byAlias.set(record.alias, value);
        return send(200, { key: value, token_id: record.keyId });
      }
      if (route === "GET /key/info") {
        if (refuseInfo) return send(400, { error: { message: "Key not found" } });
        const asked = String(url.searchParams.get("key") ?? "");
        const record = keys.get(asked)
          ?? (infoTakesHash ? [...keys.values()].find((one) => one.keyId === asked) : undefined);
        if (record == null) return send(400, { error: { message: "Key not found" } });
        return send(200, { info: { key_alias: record.alias, token: record.keyId, spend: record.spend, max_budget: record.maxBudget, models: record.models } });
      }
      if (route === "POST /key/delete") {
        if (refuseDelete) return send(500, { error: { message: "the key database is unavailable" } });
        const aliases = Array.isArray(body?.key_aliases) ? body.key_aliases.map(String) : [];
        const removed = [];
        for (const alias of aliases) {
          const value = byAlias.get(alias);
          if (value === undefined) continue;
          keys.delete(value); byAlias.delete(alias); removed.push(alias);
        }
        return send(200, { deleted_keys: removed });
      }
      if (route === "GET /key/list") {
        if (refuseList) return send(500, { error: { message: "the key database is unavailable" } });
        // THE CEILING AND THE PAGING, copied from the real build. MEASURED on this Mac against
        // docker.litellm.ai/berriai/litellm-database:v1.100.0: size=1000 answers 422, size=100 with a
        // page answers 200, and WITHOUT return_full_object the rows are bare token strings carrying
        // no alias at all. The first cut of the sweep asked for size=1000 and so came back ok:false
        // reporting nothing orphaned on a proxy that was holding an orphan. A stub that accepted any
        // size would have passed that bug through.
        const size = Number(url.searchParams.get("size") ?? "10");
        if (Number.isFinite(size) && size > 100) {
          return send(422, { detail: [{ loc: ["query", "size"], msg: "ensure this value is less than or equal to 100" }] });
        }
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
        const full = String(url.searchParams.get("return_full_object") ?? "") === "true";
        const all = [...keys.values()];
        const pageSize = Number.isFinite(size) && size > 0 ? size : 10;
        const slice = all.slice((page - 1) * pageSize, page * pageSize);
        return send(200, {
          keys: slice.map((one) => (full ? { key_alias: one.alias, token: one.keyId } : one.keyId)),
          total_count: all.length,
          current_page: page,
          total_pages: Math.max(1, Math.ceil(all.length / pageSize)),
        });
      }
      if (route === "GET /model/info") return send(200, { data: deployments });
      if (route === "POST /model/new") {
        const id = `dep-${deployments.length + 1}`;
        deployments.push({ model_name: body?.model_name, litellm_params: { ...(body?.litellm_params ?? {}) }, model_info: { id, db_model: true, ...(body?.model_info ?? {}) } });
        return send(200, { model_id: id, model_name: body?.model_name });
      }
      if (route === "POST /model/delete") {
        deployments = deployments.filter((row) => row.model_info.id !== String(body?.id ?? ""));
        return send(200, {});
      }
      return send(404, { error: { message: `no route ${route} on this stub` } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    masterKey,
    calls,
    callsTo: (route) => calls.filter((call) => call.route === route),
    keyByAlias: (alias) => keys.get(byAlias.get(alias)) ?? null,
    keyCount: () => keys.size,
    aliases: () => [...byAlias.keys()],
    deployments: () => deployments.map((row) => ({ ...row })),
    chargeAlias(alias, dollars) {
      const record = keys.get(byAlias.get(alias));
      if (record == null) return false;
      record.spend += dollars;
      return true;
    },
    plantKey(alias) {
      const value = `sk-orphan-${randomBytes(4).toString("hex")}`;
      keys.set(value, { key: value, keyId: `hashed-orphan-${keys.size}`, alias, models: [], allowedRoutes: [], maxBudget: null, softBudget: null, metadata: {}, spend: 0 });
      byAlias.set(alias, value);
      return value;
    },
    set refuseMint(on) { refuseMint = on === true; },
    set refuseInfo(on) { refuseInfo = on === true; },
    set refuseDelete(on) { refuseDelete = on === true; },
    set refuseList(on) { refuseList = on === true; },
    set infoTakesHash(on) { infoTakesHash = on === true; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** plan-zai as the R750 really carries it: an openai/ row with a credential, a base url and prices. */
const planZaiRow = (overrides = {}) => ({
  model_name: CODING_SOURCE_ALIAS,
  litellm_params: {
    model: "openai/glm-5.3",
    api_base: "https://api.z.ai/api/coding/paas/v4",
    litellm_credential_name: "zai-1",
    input_cost_per_token: 0.0000006,
    output_cost_per_token: 0.0000022,
    ...(overrides.params ?? {}),
  },
  model_info: { id: "dep-plan-zai-1", db_model: true, tb_provider: "zai", tb_key_slot: "zai-1", tb_customer_visible: true, ...(overrides.info ?? {}) },
});

// EVERY LEDGER BUILT IN THIS FILE WAITS NO TIME FOR THE SPEND, and the wait itself is measured in
// its own case below. readSpend polls /key/info until the figure is above zero, because the real build
// books a key's spend from a batch writer about fifteen seconds late and a close that read once would
// write a ZERO -- the one answer that is indistinguishable from free. Twenty seconds a close is right
// on the R750 and wrong in a test suite, so these pass 0 and the waiting is proved on purpose.
const ledgerOn = async (proxyStub, { store = memory(), now } = {}) => ({
  store,
  tasks: createCodeTasks({
    store,
    spendWaitMs: 0,
    proxy: createProxyClient({ config: { proxyUrl: proxyStub.url, proxyMasterKey: proxyStub.masterKey } }),
    ...(now ? { now } : {}),
  }),
});

// ---- the mint -------------------------------------------------------------------------------------

test("a task key carries the Anthropic doors, one model, a hard cap and its own alias", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(opened.ok, true, opened.message);

    const sent = proxy.callsTo("POST /key/generate");
    assert.equal(sent.length, 1, "one task, one key");
    const body = sent[0].body;

    // THE TWO DOORS. A key without these answers 403 on /v1/messages, which a coding agent narrates
    // as the model refusing to work -- the failure that is indistinguishable from a bad model.
    assert.ok(body.allowed_routes.includes("/v1/messages"), "the task key cannot speak the Anthropic wire");
    assert.ok(body.allowed_routes.includes("/v1/messages/count_tokens"), "the agent cannot count its own context");
    // And the tenant's own doors, so a coding agent is not a second-class citizen on the proxy.
    for (const route of TENANT_ALLOWED_ROUTES) {
      assert.ok(body.allowed_routes.includes(route), `the task key lost the tenant door ${route}`);
    }
    assert.deepEqual([...body.allowed_routes].sort(), [...CODE_TASK_ROUTES].sort(), "the door list is not the frozen one");

    // ONE MODEL. A key that could run plan-zai would let a coding task spend the customer's own
    // inference plan through a door that has no per-turn cap on it.
    assert.deepEqual(body.models, [CODING_ALIAS]);

    // THE CAP IS A STOP AND NOT A READING.
    assert.equal(body.max_budget, 2);
    assert.equal(body.soft_budget, undefined, "a soft budget never fails a request, so it is not a cap");

    assert.equal(body.key_alias, codeTaskKeyAlias("demo", "t1"));
    assert.equal(body.key_alias, "titanbot-demo-code-t1");
    assert.notEqual(body.key_alias, proxyKeyAlias("demo"), "a task key wearing the box's alias is a revoke that stops the workspace");
    assert.deepEqual(body.metadata, { slug: "demo", taskId: "t1", agentId: "a_titan" });
    // No MCP grant: a sandbox has no egress, so a web tool on this key would be a door to nowhere.
    assert.equal(body.object_permission, undefined);
    assert.equal(typeof opened.key, "string");
    assert.ok(opened.key.length > 0);
  } finally { await proxy.close(); store.close(); }
});

test("the tenant door list is unchanged, so nobody has quietly handed every box the Anthropic wire", () => {
  // THE ONE-LINE SHORTCUT THIS WAVE MUST NEVER TAKE. Adding these two paths to TENANT_ALLOWED_ROUTES
  // makes a coding task work without a per-task key at all -- and hands every box on the bridge an
  // Anthropic door on the operator's own subscriptions, with no cap and no revoke. This assertion is
  // here so that edit fails in a test named after the reason rather than passing silently.
  assert.equal(TENANT_ALLOWED_ROUTES.includes("/v1/messages"), false);
  assert.equal(TENANT_ALLOWED_ROUTES.includes("/v1/messages/count_tokens"), false);
  assert.deepEqual([...TENANT_ALLOWED_ROUTES], [
    "/v1/chat/completions", "/chat/completions",
    "/v1/models", "/models",
    "/tinyfish/fetch", "/tinyfish/search", "/mcp", "/mcp/",
  ]);
});

test("the cap is a hard budget whether or not this server is in enforce mode", async () => {
  // CP_PROXY_ENFORCE governs a TENANT's allowance, where observe mode is a deliberate half measure:
  // the number is produced and nothing is stopped. It governs nothing here. A coding agent in a loop
  // is the thing this cap exists for, and a cap that cannot fail a request would watch it spend.
  for (const enforce of [false, true]) {
    const proxy = await startKeyProxy();
    const { store, tasks } = await ledgerOn(proxy);
    try {
      store.setSetting("code.capUsd.demo", "0.5", "a test");
      const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: `t-${enforce}` });
      assert.equal(opened.ok, true);
      assert.equal(opened.capUsd, 0.5);
      const body = proxy.callsTo("POST /key/generate")[0].body;
      assert.equal(body.max_budget, 0.5);
      assert.equal(body.soft_budget, undefined);
    } finally { await proxy.close(); store.close(); }
  }
});

test("revoking a task posts the task alias only, and a tenant revoke never posts a task alias", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    // The tenant's own key, beside the task's, so a revoke that took the wrong one would be visible.
    proxy.plantKey(proxyKeyAlias("demo"));

    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 3 });
    const deletes = proxy.callsTo("POST /key/delete");
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].body.key_aliases, ["titanbot-demo-code-t1"]);
    assert.ok(proxy.keyByAlias(proxyKeyAlias("demo")) != null, "closing a coding task took the workspace's own key down");
    assert.equal(proxy.keyByAlias("titanbot-demo-code-t1"), null, "the task key is still live after its task ended");

    // And the other direction: cp/proxy.mjs's tenant revoke posts exactly one string, the slug's.
    const second = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t2" });
    assert.equal(second.ok, true);
    await client.deleteKeyByAlias("demo");
    const tenantDelete = proxy.callsTo("POST /key/delete").at(-1);
    assert.deepEqual(tenantDelete.body.key_aliases, ["titanbot-demo"]);
    assert.ok(proxy.keyByAlias("titanbot-demo-code-t2") != null, "a tenant revoke took a running task's key with it");
  } finally { await proxy.close(); store.close(); }
});

test("a close reads the spend before the revoke, and a null stays a null", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    proxy.chargeAlias("titanbot-demo-code-t1", 0.1734);
    const closed = await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 4.5 });
    assert.equal(closed.ok, true);
    assert.equal(closed.spendUsd, 0.1734);
    assert.equal(closed.revoked, true);

    // THE ORDER, asserted as an order. A deleted key has no record to ask about, so reading after
    // revoking would answer nothing for ever and the ledger would hold a null on every row.
    const order = proxy.calls.map((call) => call.route).filter((route) => route === "GET /key/info" || route === "POST /key/delete");
    assert.deepEqual(order, ["GET /key/info", "POST /key/delete"]);

    const row = tasks.listTasks("demo", 10)[0];
    assert.equal(row.spendUsd, 0.1734);
    assert.equal(row.minutes, 4.5);
    assert.equal(row.outcome, "done");
    assert.equal(row.revoked, true);
  } finally { await proxy.close(); store.close(); }
});

test("a spend nobody could read is null and never zero, and the row says why", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    proxy.refuseInfo = true;
    // AND IT DOES NOT WAIT OUT THE BUDGET FOR IT. "Key not found" is a 400 and a proxy that says it
    // will go on saying it, so the close comes back at once rather than in twenty seconds. A 5xx would
    // keep polling, because that is the kind of answer that comes back.
    const waited = Date.now();
    const closed = await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 2, spendWaitMs: 20_000 });
    assert.ok(Date.now() - waited < 3000, `a terminal refusal cost ${Date.now() - waited} ms of waiting`);
    assert.equal(closed.spendUsd, null, "a proxy that would not answer produced a dollar figure");
    assert.match(closed.spendWhy, /would not say/);
    const row = tasks.listTasks("demo", 10)[0];
    // A ZERO HERE IS A LIE THAT LOOKS LIKE A MEASUREMENT. The task ran for two minutes on somebody's
    // subscription; "nothing" and "we did not read it" are opposite facts that render identically.
    assert.equal(row.spendUsd, null);
    assert.notEqual(row.spendUsd, 0);
    assert.match(row.detail, /would not say/);
    // The minutes were measured and they survive a spend that was not.
    assert.equal(row.minutes, 2);
  } finally { await proxy.close(); store.close(); }
});

test("a spend that has not landed yet is waited for, and a zero is never written as a measurement", async () => {
  // THE MEASUREMENT THIS EXISTS FOR. On this Mac against docker.litellm.ai/berriai/litellm-database:
  // v1.100.0, a turn the per-token prices say cost $0.1211 read back as spend 0 on /key/info at
  // +7 ms and at every second out to +12 s, and came back as exactly 0.1211 at +15 s: the proxy books
  // a key's spend from the same batch writer /spend/logs is filled from. A close that read once would
  // write 0 into the ledger for every task that ever ran, and a zero on a screen is indistinguishable
  // from free.
  const proxy = await startKeyProxy();
  const store = memory();
  try {
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const tasks = createCodeTasks({ store, proxy: client, spendWaitMs: 3000 });
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    // The spend appears a second into the wait, the way the real proxy's batch writer makes it.
    setTimeout(() => proxy.chargeAlias("titanbot-demo-code-t1", 0.1211), 900);
    const closed = await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 2 });
    assert.equal(closed.spendUsd, 0.1211, "the close gave up before the proxy had booked the spend");
    assert.equal(closed.spendWhy, "");

    // And when it never lands inside the budget, the row says it is not known rather than zero.
    const second = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t2" });
    const slow = await tasks.closeTask({ id: second.id, outcome: "done", minutes: 1, spendWaitMs: 150 });
    assert.equal(slow.spendUsd, null);
    assert.notEqual(slow.spendUsd, 0);
    assert.match(slow.spendWhy, /had still not booked this task's spend/);
    const row = tasks.listTasks("demo", 10).find((one) => one.taskId === "t2");
    assert.equal(row.spendUsd, null);
    assert.match(row.detail, /not known/);
    // The key is still given back, however the spend read went.
    assert.equal(row.revoked, true);
  } finally { await proxy.close(); store.close(); }
});

test("the row is closed before the spend is waited for, so a relay retry is a no-op", async () => {
  const proxy = await startKeyProxy();
  const store = memory();
  try {
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const tasks = createCodeTasks({ store, proxy: client, spendWaitMs: 1200 });
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });

    // The relay will not hold a request open for twenty seconds, so it retries the close while the
    // first one is still waiting on /key/info. The retry must see a closed row and do nothing, rather
    // than start a second wait against the same key.
    const first = tasks.closeTask({ id: opened.id, outcome: "done", minutes: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retry = await tasks.closeTask({ id: opened.id, outcome: "timed_out", minutes: 99 });
    assert.equal(retry.already, true, "the retry started a second close");
    await first;
    const row = tasks.listTasks("demo", 10)[0];
    assert.equal(row.outcome, "done", "the retry overwrote the outcome the first close measured");
    assert.equal(row.minutes, 5);
    assert.equal(proxy.callsTo("POST /key/delete").length, 1, "the key was revoked twice");
  } finally { await proxy.close(); store.close(); }
});

test("a revoke that did not land is written down and retried by the sweep, not logged once", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    proxy.refuseDelete = true;
    const closed = await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 1 });
    assert.equal(closed.revoked, false);
    assert.match(closed.revokeWhy, /the proxy answered 500/);
    const row = tasks.listTasks("demo", 10)[0];
    assert.equal(row.revoked, false);
    assert.match(row.detail, /was not revoked/);
    // A LIVE CREDENTIAL ON THE OPERATOR'S OWN SUBSCRIPTIONS is what that row is, so the sweep has to
    // find it: the key is at the proxy and its row is closed.
    proxy.refuseDelete = false;
    const swept = await tasks.sweepTaskKeys();
    assert.deepEqual(swept.orphans, ["titanbot-demo-code-t1"]);
    assert.deepEqual(swept.deleted, ["titanbot-demo-code-t1"]);
    assert.equal(proxy.keyByAlias("titanbot-demo-code-t1"), null);
    assert.equal(tasks.listTasks("demo", 10)[0].revoked, true, "the row still says the key is outstanding");
  } finally { await proxy.close(); store.close(); }
});

test("the sweep deletes a key with no row at all, and leaves a running task's key alone", async () => {
  const clock = { at: Date.parse("2026-09-09T12:00:00Z") };
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy, { now: () => clock.at });
  try {
    const running = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "live" });
    assert.equal(running.ok, true);
    // A key from a control plane that died before it could write anything: at the proxy, in no table.
    proxy.plantKey("titanbot-demo-code-ghost");
    // And the tenant's own key, which must survive every sweep for ever.
    proxy.plantKey(proxyKeyAlias("demo"));

    const dry = await tasks.sweepTaskKeys({ dryRun: true });
    assert.deepEqual(dry.orphans, ["titanbot-demo-code-ghost"]);
    assert.deepEqual(dry.deleted, [], "a dry run deleted something");
    assert.ok(proxy.keyByAlias("titanbot-demo-code-ghost") != null);

    const swept = await tasks.sweepTaskKeys();
    assert.deepEqual(swept.deleted, ["titanbot-demo-code-ghost"]);
    assert.ok(proxy.keyByAlias("titanbot-demo-code-live") != null, "the sweep revoked a task that is still running");
    assert.ok(proxy.keyByAlias(proxyKeyAlias("demo")) != null, "the sweep took the workspace's own key");
    assert.deepEqual(swept.closed, [], "nothing is late yet");

    // And the second selection: a claim nothing ever came back about. Thirty minutes plus ten.
    clock.at += 41 * 60_000;
    const late = await tasks.sweepTaskKeys();
    assert.equal(late.closed.length, 1);
    assert.equal(late.closed[0].taskId, "live");
    const row = tasks.listTasks("demo", 10).find((one) => one.taskId === "live");
    assert.equal(row.outcome, "lost");
    assert.equal(row.minutes, null, "a task nobody reported on has no measured minutes");
    assert.equal(proxy.keyByAlias("titanbot-demo-code-live"), null, "a lost task left its credential live");
  } finally { await proxy.close(); store.close(); }
});

test("the sweep asks for a page it is allowed and walks every page, so an orphan on page two is found", async () => {
  const proxy = await startKeyProxy();
  const store = memory();
  try {
    const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
    const tasks = createCodeTasks({ store, spendWaitMs: 0, proxy: client });
    // A hundred and one keys at the proxy, which is one more than a page: the measured ceiling on
    // /key/list?size is 100, so the orphan can only be found by paging.
    for (let n = 0; n < 101; n += 1) proxy.plantKey(`titanbot-demo-code-ghost${n}`);

    const swept = await tasks.sweepTaskKeys();
    assert.equal(swept.ok, true, swept.why);
    assert.equal(swept.deleted.length, 101, "the sweep stopped at the first page and left orphans live");
    assert.ok(swept.pages >= 2, `it saw ${swept.pages} page(s)`);
    assert.equal(proxy.keyCount(), 0);

    // And the two parameters it may never drop. size over the ceiling is a 422 the first cut of this
    // really sent, and without return_full_object the rows carry no alias to match.
    const asked = proxy.callsTo("GET /key/list");
    assert.ok(asked.length >= 2, "it asked for one page only");
    for (const call of asked) {
      assert.equal(call.query.return_full_object, "true", "a page without the full object carries no alias at all");
      assert.ok(Number(call.query.size) <= 100, `size ${call.query.size} is refused 422 by the real build`);
    }
  } finally { await proxy.close(); store.close(); }
});

test("a proxy that will not list its keys says so and the late claims are still closed", async () => {
  const clock = { at: Date.parse("2026-09-09T12:00:00Z") };
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy, { now: () => clock.at });
  try {
    await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "live" });
    proxy.refuseList = true;
    clock.at += 41 * 60_000;
    const swept = await tasks.sweepTaskKeys();
    assert.equal(swept.ok, false);
    assert.match(swept.why, /the proxy answered 500/);
    // The half that does not need the list still runs: a row holding a concurrency slot for ever is
    // a workspace that can never start another task.
    assert.equal(swept.closed.length, 1);
  } finally { await proxy.close(); store.close(); }
});

test("a mint that fails starts nothing, says so in plain words and leaves a row that says why", async () => {
  const proxy = await startKeyProxy({ refuseMint: true });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(opened.ok, false);
    assert.equal(opened.error, "no_credential");
    // A sentence a bot can read out. No vendor name, no route, no status code.
    assert.match(opened.message, /did not answer, so nothing was started/);
    assert.equal(/LiteLLM|litellm|proxy|500/.test(opened.message), false, opened.message);
    const row = tasks.listTasks("demo", 10)[0];
    assert.equal(row.outcome, "failed");
    assert.equal(row.minutes, 0, "no container existed, so zero minutes is measured rather than unknown");
    assert.equal(row.spendUsd, null);
    assert.equal(row.revoked, true, "there is no outstanding credential for the sweep to chase");
  } finally { await proxy.close(); store.close(); }
});

test("after a restart the spend is read by the hashed handle, and is null when that is refused too", async () => {
  // The key value is held in memory for the life of the task and is never on disk, in a label or in
  // the ledger. A control plane restart loses it, so the fallback read is the stored HASH -- which is
  // safe to persist because it is not a credential. Whether the deployed build answers /key/info to a
  // hash is measured by the gate; both answers are honest here.
  for (const infoTakesHash of [true, false]) {
    const proxy = await startKeyProxy({ infoTakesHash });
    const store = memory();
    try {
      const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
      const before = createCodeTasks({ store, spendWaitMs: 0, proxy: client });
      const opened = await before.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
      proxy.chargeAlias("titanbot-demo-code-t1", 0.42);

      // A SECOND OBJECT OVER THE SAME STORE is what a restart looks like from here: the rows are
      // there and the in-memory key is gone.
      const after = createCodeTasks({ store, spendWaitMs: 0, proxy: client });
      const closed = await after.closeTask({ id: opened.id, outcome: "done", minutes: 5 });
      if (infoTakesHash) {
        assert.equal(closed.spendUsd, 0.42, "the hashed handle did not read the spend back");
      } else {
        assert.equal(closed.spendUsd, null);
        assert.notEqual(closed.spendUsd, 0);
      }
      assert.equal(closed.revoked, true, "a restart must not stop the revoke: the alias is derivable");
    } finally { await proxy.close(); store.close(); }
  }
});

test("a coding task's key value is never written into the ledger", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    await tasks.closeTask({ id: opened.id, outcome: "done", minutes: 1 });
    // Every row, as JSON, swept for the real minted key's bytes -- the way tests/cp-server sweeps
    // every route for a tenant key.
    const everything = JSON.stringify([tasks.listTasks("demo", 100), tasks.rollup(""), tasks.settings("demo")]);
    assert.equal(everything.includes(opened.key), false, "the ledger carried a live credential");
    assert.ok(everything.includes("titanbot-demo-code-t1"), "and it does carry the alias, which is the handle");
  } finally { await proxy.close(); store.close(); }
});

// ---- the hidden deployment ------------------------------------------------------------------------

test("the coding deployment is derived from plan-zai and declares the hosted_vllm prefix", async () => {
  const proxy = await startKeyProxy({ deployments: [planZaiRow()] });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const planned = await tasks.ensureCodingDeployment({ dryRun: true });
    assert.equal(planned.ok, true, planned.why);
    assert.equal(planned.plan.alias, CODING_ALIAS);

    // THE PREFIX THAT LOOKS LIKE A TYPO AND IS NOT. Declared openai/ against the same endpoint, the
    // proxy drives the vendor's /responses surface and the Anthropic wire answers 200 with an error
    // body inside it -- a failure that goes red nowhere and that a model narrates as itself
    // refusing. This assertion is what stops somebody tidying it.
    assert.equal(planned.plan.vendorModel, `${CODING_VENDOR_PREFIX}glm-5.3`);
    assert.equal(planned.plan.vendorModel, "hosted_vllm/glm-5.3");
    assert.equal(planned.plan.vendorModel.startsWith("openai/"), false);

    const made = await tasks.ensureCodingDeployment();
    assert.equal(made.ok, true, made.why);
    const row = proxy.deployments().find((one) => one.model_name === CODING_ALIAS);
    assert.ok(row != null, "nothing was created");
    // Same endpoint, same credential slot, same prices: a coding task runs on the subscription the
    // plan runs on, and an unpriced deployment turns every dollar downstream into a zero.
    assert.equal(row.litellm_params.api_base, "https://api.z.ai/api/coding/paas/v4");
    assert.equal(row.litellm_params.litellm_credential_name, "zai-1");
    assert.equal(row.litellm_params.input_cost_per_token, 0.0000006);
    assert.equal(row.litellm_params.output_cost_per_token, 0.0000022);
    // ITS OWN TIMEOUT, because the proxy's global request_timeout is 60 and the proxy may not be
    // restarted to change it. A coding turn longer than a minute would come back as a provider error.
    assert.equal(row.litellm_params.timeout, 600);
    assert.equal(row.litellm_params.stream_timeout, 600);
    // AND NO CUSTOMER-VISIBLE FLAG, copied or otherwise, so this alias can never reach a Settings
    // page. plan-zai's own row carries tb_customer_visible true, so this is a real risk and not a
    // theoretical one.
    assert.equal(row.model_info.tb_customer_visible, undefined);
    assert.equal(row.model_info.tb_provider, "zai");
  } finally { await proxy.close(); store.close(); }
});

test("the coding deployment is created once and the second ask refuses in plain words", async () => {
  const proxy = await startKeyProxy({ deployments: [planZaiRow()] });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    assert.equal((await tasks.ensureCodingDeployment()).ok, true);
    const again = await tasks.ensureCodingDeployment();
    assert.equal(again.ok, false);
    assert.equal(again.exists, true);
    assert.match(again.why, /already on the proxy, so nothing was created/);
    assert.equal(proxy.deployments().filter((row) => row.model_name === CODING_ALIAS).length, 1);

    // And the rollback leg: one verb takes it away and plan-zai is untouched.
    const removed = await tasks.removeCodingDeployment();
    assert.equal(removed.ok, true);
    assert.equal(proxy.deployments().filter((row) => row.model_name === CODING_ALIAS).length, 0);
    assert.equal(proxy.deployments().filter((row) => row.model_name === CODING_SOURCE_ALIAS).length, 1);
  } finally { await proxy.close(); store.close(); }
});

test("no plan-zai, no coding deployment, and the refusal says which row is missing", async () => {
  const proxy = await startKeyProxy({ deployments: [] });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const answer = await tasks.ensureCodingDeployment();
    assert.equal(answer.ok, false);
    assert.match(answer.why, /plan-zai is not on this proxy/);
    assert.equal(proxy.callsTo("POST /model/new").length, 0, "it wrote a deployment with nothing behind it");
  } finally { await proxy.close(); store.close(); }
});

test("a plan-zai with no price makes a coding deployment that says it is not priced", async () => {
  const proxy = await startKeyProxy({ deployments: [planZaiRow({ params: { input_cost_per_token: null, output_cost_per_token: null } })] });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const planned = await tasks.ensureCodingDeployment({ dryRun: true });
    assert.equal(planned.ok, true);
    // NOT A ZERO AND NOT A GUESS. On the R750 every Z.AI deployment was once created with no price at
    // all and 654 spend rows carried 0.000000, which the panel drew as $0.00 for a customer at
    // 665,915 tokens. A coding task on an unpriced deployment will report its spend as nothing, and
    // the operator has to be told that when the alias is made rather than when the bill arrives.
    assert.equal(planned.plan.priced, false);
    assert.equal(planned.plan.params.input_cost_per_token, undefined);
  } finally { await proxy.close(); store.close(); }
});

test("a pool of plan-zai rows is said out loud rather than silently halved", async () => {
  const proxy = await startKeyProxy({
    deployments: [planZaiRow(), planZaiRow({ info: { id: "dep-plan-zai-2", tb_key_slot: "zai-2" }, params: { litellm_credential_name: "zai-2" } })],
  });
  const { store, tasks } = await ledgerOn(proxy);
  try {
    const planned = await tasks.ensureCodingDeployment({ dryRun: true });
    assert.equal(planned.plan.from.poolSize, 2);
    assert.equal(planned.plan.from.id, "dep-plan-zai-1", "the first usable row is the one it rides");
  } finally { await proxy.close(); store.close(); }
});

// ---- the E2B key, which is write only -------------------------------------------------------------

test("the cloud sandbox account is handed to a task and comes back out of nothing else", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  const planted = `e2b_${randomBytes(16).toString("hex")}`;
  try {
    assert.equal(tasks.settings("demo").e2bKeySet, false);
    tasks.setSettings({ e2bKey: planted, actor: "a test" });
    assert.equal(tasks.settings("demo").e2bKeySet, true);

    // THE LISTING CANNOT READ IT. cp/store.mjs hands every setting value back except the names in
    // SECRET_SETTINGS, and cp/code.mjs adds this one to that Set at import rather than editing that
    // file. Without that line the operator's E2B account would be on the settings listing in clear.
    const listed = JSON.stringify(store.listSettings());
    assert.equal(listed.includes(planted), false, "the settings listing carried the cloud sandbox account");
    assert.ok(listed.includes(CODE_E2B_KEY_SETTING), "and the NAME is on the listing, so an operator can see one is set");

    // Neither can anything this module answers, apart from the one open it is for.
    const surfaces = JSON.stringify([tasks.settings(""), tasks.settings("demo"), tasks.rollup(""), tasks.listTasks("demo", 10)]);
    assert.equal(surfaces.includes(planted), false);

    // And the one place it does go: an open for a workspace set to run on a cloud sandbox.
    tasks.setSettings({ slug: "demo", provider: "e2b", actor: "a test" });
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(opened.ok, true, opened.message);
    assert.equal(opened.provider, "e2b");
    assert.equal(opened.e2bKey, planted);
    // A local task never gets it, however it is set.
    const local = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t2", provider: "local" });
    assert.equal(local.e2bKey, undefined);
  } finally { await proxy.close(); store.close(); }
});

test("a cloud sandbox workspace with no account starts nothing and gives its key back", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    tasks.setSettings({ slug: "demo", provider: "e2b", actor: "a test" });
    const opened = await tasks.openTask({ slug: "demo", agentId: "a_titan", taskId: "t1" });
    assert.equal(opened.ok, false);
    assert.equal(opened.error, "no_provider");
    assert.match(opened.message, /nobody has given this system the account for it yet/);
    // The model key it had already minted is given back rather than left live on a task that never ran.
    assert.equal(proxy.keyByAlias("titanbot-demo-code-t1"), null);
    assert.equal(tasks.listTasks("demo", 10)[0].outcome, "failed");
  } finally { await proxy.close(); store.close(); }
});

test("clearing the cloud sandbox account is the only other thing that can be done to it", async () => {
  const proxy = await startKeyProxy();
  const { store, tasks } = await ledgerOn(proxy);
  try {
    tasks.setSettings({ e2bKey: "e2b_planted", actor: "a test" });
    assert.equal(tasks.e2bKeySet(), true);
    assert.equal(tasks.setSettings({ clearE2bKey: true, actor: "a test" }).ok, true);
    assert.equal(tasks.e2bKeySet(), false);
    // An empty write is a refusal rather than a silent clear, so a blank paste cannot wipe it.
    const blank = tasks.setSettings({ e2bKey: "   ", actor: "a test" });
    assert.equal(blank.ok, false);
    assert.match(blank.message, /was not given, so nothing was changed/);
  } finally { await proxy.close(); store.close(); }
});
