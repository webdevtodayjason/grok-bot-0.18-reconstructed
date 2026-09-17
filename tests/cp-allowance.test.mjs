import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import {
  CYCLE_MS,
  allowanceState,
  createAllowanceService,
  cycleOf,
  usageFor,
} from "../cp/allowance.mjs";
import { openStore } from "../cp/store.mjs";
import { makeTempRoot } from "./cp-support.mjs";
import { createApp } from "../cp/server.mjs";
import { loadConfig } from "../cp/provision.mjs";
import { mintSessionToken, tenantSessionSecret } from "../cp/session.mjs";
import { Readable } from "node:stream";

test("five-day cycles are half-open and days left rounds up", () => {
  const createdAt = Date.parse("2026-09-01T12:00:00.000Z");
  const tenant = { createdAt };
  assert.deepEqual(cycleOf(tenant, createdAt), {
    index: 0,
    startsAt: "2026-09-01T12:00:00.000Z",
    endsAt: "2026-09-06T12:00:00.000Z",
    daysLeft: 5,
    pct: 0,
  });
  assert.equal(cycleOf(tenant, createdAt + CYCLE_MS - 1).daysLeft, 1);
  const next = cycleOf(tenant, createdAt + CYCLE_MS);
  assert.equal(next.index, 1);
  assert.equal(next.daysLeft, 5);
  assert.equal(next.pct, 0);
});

test("usage sums prompt and completion fields without allowing missing values to become NaN", () => {
  const cycle = { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-06T00:00:00.000Z" };
  const answer = usageFor("acme", cycle, [
    { startTime: "2026-09-01T00:00:00.000Z", key_alias: "titanbot-acme", model: "GLM-5.3", prompt_tokens: 10, completion_tokens: 4 },
    { startTime: "2026-09-02T00:00:00.000Z", key_alias: "titanbot-acme", model: "GLM-5.3", prompt_tokens: 6 },
    { startTime: "2026-09-03T00:00:00.000Z", key_alias: "titanbot-acme", model: "Other", completion_tokens: "bad" },
    { startTime: "2026-09-06T00:00:00.000Z", key_alias: "titanbot-acme", prompt_tokens: 999 },
    { startTime: "2026-09-02T00:00:00.000Z", key_alias: "titanbot-other", prompt_tokens: 999 },
  ]);
  assert.equal(answer.used, 20);
  assert.equal(Number.isNaN(answer.used), false);
  assert.deepEqual(answer.models[0], { model: "GLM-5.3", tokens: 20 });
});

test("allowance states change at the exact thresholds", () => {
  assert.equal(allowanceState(79.999), "ok");
  assert.equal(allowanceState(80), "warning");
  assert.equal(allowanceState(99.999), "warning");
  assert.equal(allowanceState(100), "exhausted");
});

test("a workspace defaults to Sprout and a saved level and override are read back", async () => {
  const root = await makeTempRoot("cp-allowance-");
  const at = Date.parse("2026-09-02T00:00:00.000Z");
  const store = openStore({ dataDir: root, now: () => at });
  try {
    store.createTenant({ slug: "acme", name: "Acme" });
    const service = createAllowanceService({ store, now: () => at, proxy: { spendRows: async () => ({ ok: true, rows: [] }) } });
    assert.equal((await service.get("acme")).levelId, "sprout");
    assert.equal(service.set("acme", { level: "seed", capOverride: 1234 }, "admin@example.com").ok, true);
    const answer = await service.get("acme");
    assert.equal(answer.level, "Seed");
    assert.equal(answer.cap, 1234);
    assert.equal(store.getSetting("allowance.level.acme"), "seed");
    assert.equal(store.getSetting("allowance.capOverride.acme"), "1234");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function responseDouble() {
  return {
    status: 0, body: "", headersSent: false,
    setHeader() {},
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body = "") { this.body = String(body); },
  };
}

test("the allowance route opens to its workspace session and the relay token, not another workspace", async () => {
  const root = await makeTempRoot("cp-allowance-route-");
  const at = Date.parse("2026-09-02T00:00:00.000Z");
  const relayToken = "r".repeat(40);
  const adminToken = "a".repeat(40);
  const sessionSecret = "s".repeat(40);
  const config = loadConfig({ CP_DATA_DIR: root, CP_RELAY_TOKEN: relayToken, CP_ADMIN_TOKEN: adminToken, CP_SESSION_SECRET: sessionSecret });
  const store = openStore({ dataDir: root, now: () => at });
  const app = createApp({ config, store, now: () => at, proxy: { configured: true, spendRows: async () => ({ ok: true, rows: [] }) } });
  try {
    store.createTenant({ slug: "acme", name: "Acme" });
    const ask = async (token) => {
      const response = responseDouble();
      await app.handle({ method: "GET", url: "/v1/tenants/acme/allowance", headers: { authorization: `Bearer ${token}` } }, response);
      return { status: response.status, body: JSON.parse(response.body) };
    };
    assert.equal((await ask(relayToken)).status, 200);
    const session = mintSessionToken({ tenant: "acme", sub: "acct", email: "a@example.com", host: "console.test", iat: at, exp: at + 60_000, jti: "one" }, tenantSessionSecret(sessionSecret, "acme"), at).token;
    assert.equal((await ask(session)).status, 200);
    const other = mintSessionToken({ tenant: "other", sub: "acct", email: "b@example.com", host: "console.test", iat: at, exp: at + 60_000, jti: "two" }, tenantSessionSecret(sessionSecret, "other"), at).token;
    assert.equal((await ask(other)).status, 401);

    const request = Readable.from([Buffer.from(JSON.stringify({ level: "grove", capOverride: "4321" }))]);
    Object.assign(request, {
      method: "POST", url: "/v1/admin/clients/acme/allowance",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    const saved = responseDouble();
    await app.handle(request, saved);
    assert.equal(saved.status, 200, saved.body);
    assert.equal(JSON.parse(saved.body).allowance.cap, 4321);
    assert.equal(store.getSetting("allowance.level.acme"), "grove");
    assert.equal(store.getSetting("allowance.capOverride.acme"), "4321");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A 429 for an exhausted upstream still writes a spend row carrying the tokens it would have sent.
// Counting those billed a tenant for an outage: beta-36's console read 1,553,655 tokens consumed on
// 2026-09-17 and every one of them belonged to a refused request.
test("a failed request produced no answer, so it spends no allowance", () => {
  const cycle = { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-06T00:00:00.000Z" };
  const answer = usageFor("acme", cycle, [
    { startTime: "2026-09-01T01:00:00.000Z", key_alias: "titanbot-acme", model_group: "plan-zai", status: "success", prompt_tokens: 100, completion_tokens: 10 },
    { startTime: "2026-09-02T01:00:00.000Z", key_alias: "titanbot-acme", model_group: "plan-zai", status: "failure", prompt_tokens: 900_000, completion_tokens: 0 },
    { startTime: "2026-09-02T02:00:00.000Z", key_alias: "titanbot-acme", model_group: "plan-zai-talk", status: "Failure", prompt_tokens: 500_000, completion_tokens: 0 },
    // No status at all: an older row, or a build that stopped carrying the field. It still counts,
    // because undercounting one tenant beats zeroing every tenant the day the field disappears.
    { startTime: "2026-09-03T01:00:00.000Z", key_alias: "titanbot-acme", model_group: "plan-qwen", prompt_tokens: 40, completion_tokens: 2 },
  ]);
  assert.equal(answer.used, 152, "only the answered requests are counted");
  assert.ok(!answer.models.some((row) => row.model === "plan-zai-talk"), "a refused group never reaches the breakdown");
});
