// The subscriptions module (docs/SUBSCRIPTIONS-CONTRACT.md): adoption into a 0600 store, refresh
// through the vendor's own endpoint with our identification, never a write to the vendor's file,
// and a scan that carries no secret. The store is redirected to a temp file for the test.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = await mkdtemp(path.join(os.tmpdir(), "grokbot-subs-"));
process.env.GROK_BOT_SUBSCRIPTIONS_FILE = path.join(dir, "subscriptions.json");
const subs = await import("../ui/subscriptions.mjs");

test("a pasted key becomes a keyless endpoint row and a 0600 store entry", async () => {
  const row = await subs.adoptSubscription("zai", { apiKey: "zai-test-key-0123456789abcdef", model: "glm-4.7" }, {});
  assert.equal(row.id, "sub-zai");
  assert.equal(row.subscription, "zai");
  assert.equal("apiKey" in row, false);
  const mode = (await stat(process.env.GROK_BOT_SUBSCRIPTIONS_FILE)).mode & 0o777;
  assert.equal(mode, 0o600);
  const resolved = await subs.resolveSubscription("zai");
  assert.equal(resolved.apiKey, "zai-test-key-0123456789abcdef");
  assert.equal(resolved.transport, "chat");
  assert.equal(resolved.originator, "grok-bot");
});

test("MiniMax refresh goes to MiniMax's own token endpoint as grok-bot and updates only our store", async () => {
  const vendorFile = path.join(dir, "minimax-oauth_creds.json");
  await writeFile(vendorFile, JSON.stringify({ access_token: "old-access-token-000000", refresh_token: "old-refresh-token-0000", expiry_date: 1 }));
  const before = await readFile(vendorFile, "utf8");
  const store = await subs.readStore();
  store.minimax = { access: "old-access-token-000000", refresh: "old-refresh-token-0000", expires: Date.now() - 1, source: vendorFile };
  await subs.writeStore(store);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "new-access-token-111111", refresh_token: "new-refresh-token-1111", expired_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const resolved = await subs.resolveSubscription("minimax");
    assert.equal(resolved.refreshed, true);
    assert.equal(resolved.apiKey, "new-access-token-111111");
    assert.equal(calls[0].url, "https://account.minimax.io/oauth2/token");
    assert.equal(calls[0].init.headers["user-agent"], "grok-bot/1");
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh-token-0000");
    assert.equal(body.get("client_id"), "78257093-7e40-4613-99e0-527b14b39113");
    assert.equal((await subs.readStore()).minimax.refresh, "new-refresh-token-1111");
    assert.equal(await readFile(vendorFile, "utf8"), before, "the vendor's file is never written");
  } finally { globalThis.fetch = realFetch; }
});

test("Codex refresh goes to OpenAI's token endpoint with the Codex client id; the vendor file is untouched", async () => {
  const vendorFile = path.join(dir, "codex-auth.json");
  await writeFile(vendorFile, JSON.stringify({ tokens: { access_token: "x", refresh_token: "y" } }));
  const before = await readFile(vendorFile, "utf8");
  const store = await subs.readStore();
  store.codex = { access: "old-codex-access-000000", refresh: "old-codex-refresh-0000", accountId: "acct-1", email: "a@b", expires: Date.now() - 1, source: vendorFile };
  await subs.writeStore(store);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "new-codex-access-111111", refresh_token: "new-codex-refresh-1111", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const resolved = await subs.resolveSubscription("codex");
    assert.equal(resolved.transport, "responses");
    assert.equal(resolved.accountId, "acct-1");
    assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(await readFile(vendorFile, "utf8"), before);
  } finally { globalThis.fetch = realFetch; }
});

test("the scan never carries a secret and Claude comes from its CLI", async () => {
  const rows = await subs.scanSubscriptions({ ...process.env, ZAI_API_KEY: "zai-env-key-should-not-appear-0000" });
  const text = JSON.stringify(rows);
  assert.equal(text.includes("zai-env-key-should-not-appear-0000"), false);
  assert.equal(text.includes("new-access-token-111111"), false);
  assert.equal(text.includes("new-codex-access-111111"), false);
  assert.equal(rows.find((r) => r.id === "claude").source, "claude auth status --json");
  assert.match(rows.find((r) => r.id === "gemini").source, /existence only/);
  assert.equal(rows.find((r) => r.id === "zai").usable, true);
});
