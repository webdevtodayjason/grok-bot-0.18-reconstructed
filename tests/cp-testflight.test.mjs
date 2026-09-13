import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { openStore, TESTFLIGHT_FEEDBACK_STATES } from "../cp/store.mjs";
import {
  FEEDBACK_NOTIFY_SETTING,
  TESTFLIGHT_ISSUER_ID_SETTING,
  TESTFLIGHT_KEY_ID_SETTING,
  createFeedbackNotifier,
  createTestFlight,
  mintToken,
  readPrivateKey,
  testflightKeyFile,
} from "../cp/testflight.mjs";
import { makeTempRoot, startControlPlane } from "./cp-support.mjs";

const PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ type: "pkcs8", format: "pem" });

async function startJsonServer(handler) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { body = null; }
      const call = { method: request.method, url: request.url, headers: request.headers, body };
      calls.push(call);
      const answer = handler(call);
      const text = JSON.stringify(answer.body ?? {});
      response.writeHead(answer.status ?? 200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fixture(run) {
  const root = await makeTempRoot("cp-testflight-");
  const store = openStore({ dataDir: root });
  try { await run({ root, store }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test("the App Store Connect JWT is ES256, short lived and carries no key bytes", () => {
  const at = Date.parse("2026-09-13T12:00:00.000Z");
  const token = mintToken({ keyId: "K123", issuerId: "issuer-1", privateKeyPem: PRIVATE_KEY, now: at });
  const [header, payload, signature] = token.split(".");
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  assert.deepEqual(decode(header), { alg: "ES256", kid: "K123", typ: "JWT" });
  assert.deepEqual(decode(payload), {
    iss: "issuer-1", iat: at / 1000, exp: at / 1000 + 600, aud: "appstoreconnect-v1",
  });
  assert.equal(Buffer.from(signature, "base64url").length, 64, "ES256 must be the raw r||s pair");
  assert.equal(token.includes("PRIVATE KEY"), false);
});

test("the private key file must be 0600 and look like a p8", async () => {
  await fixture(async ({ root }) => {
    const file = path.join(root, "testflight.p8");
    await writeFile(file, PRIVATE_KEY, { mode: 0o644 });
    assert.throws(() => readPrivateKey(file), /must be mode 0600/);
    await writeFile(file, PRIVATE_KEY, { mode: 0o600 });
    await import("node:fs/promises").then(({ chmod }) => chmod(file, 0o600));
    assert.match(readPrivateKey(file), /BEGIN PRIVATE KEY/);
  });
});

test("a fake Apple and fake box produce one row and one ping per submission, once", async () => {
  const apple = await startJsonServer((call) => {
    assert.match(String(call.headers.authorization ?? ""), /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const url = new URL(call.url, "http://apple.invalid");
    if (url.pathname === "/v1/apps") {
      assert.equal(url.searchParams.get("filter[bundleId]"), "bot.titanium.app");
      return { body: { data: [{ id: "app-1", attributes: { name: "Titanium Bot" } }] } };
    }
    const crash = url.pathname.endsWith("/betaFeedbackCrashSubmissions");
    const screenshot = url.pathname.endsWith("/betaFeedbackScreenshotSubmissions");
    assert.equal(crash || screenshot, true, `unexpected Apple endpoint ${url.pathname}`);
    const id = crash ? "crash-1" : "shot-1";
    return { body: {
      data: [{
        id,
        attributes: {
          createdDate: crash ? "2026-09-13T10:00:00.000Z" : "2026-09-13T11:00:00.000Z",
          deviceModel: crash ? "iPhone16,2" : "iPhone15,4",
          osVersion: "26.0",
          comment: crash ? "It stopped on launch" : "The send button is covered",
        },
        relationships: { build: { data: { id: "build-1" } }, tester: { data: { id: "tester-1" } } },
      }],
      included: [
        { type: "builds", id: "build-1", attributes: { version: "42" } },
        { type: "betaTesters", id: "tester-1", attributes: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" } },
      ],
    } };
  });
  const box = await startJsonServer((call) => {
    assert.equal(call.headers.authorization, "Bearer gateway-token");
    if (call.url === "/api/listAgents") return { body: [{ id: "titan-1", name: "Titan", isGroup: false }] };
    if (call.url === "/api/sendPrompt") return { body: { accepted: true } };
    return { status: 404, body: { error: "not_found" } };
  });
  try {
    await fixture(async ({ root, store }) => {
      store.setSetting(TESTFLIGHT_KEY_ID_SETTING, "K123");
      store.setSetting(TESTFLIGHT_ISSUER_ID_SETTING, "issuer-1");
      const keyFile = testflightKeyFile({ dataDir: root });
      await writeFile(keyFile, PRIVATE_KEY, { mode: 0o600 });
      store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
      store.db.prepare("UPDATE tenants SET box_container = ? WHERE slug = ?").run("titanbot-box-svc", "titanium");
      const account = store.createAccount({ email: "boss@example.com", password: "a-good-password", tenant: "titanium" });
      store.setSuperAdmin(account.id, true);
      const profile = path.join(root, "titanium", "profile");
      await mkdir(profile, { recursive: true });
      await writeFile(path.join(profile, "local-docker-vm.json"), JSON.stringify({ token: "gateway-token" }), { mode: 0o600 });
      const config = { dataDir: root, tenantRoot: root, boxUrlOverride: box.url };
      const notify = createFeedbackNotifier({ store, config });
      const desk = createTestFlight({ store, config, baseUrl: apple.url, notify });

      const first = await desk.poll();
      assert.deepEqual(first, { ok: true, why: "", stored: 2, notified: 2 });
      assert.equal(store.countTestflightFeedback(), 2);
      assert.deepEqual(store.listTestflightFeedback({}).map((row) => row.kind), ["screenshot", "crash"]);
      assert.equal(store.getTestflightFeedback("shot-1").build, "42");
      assert.equal(store.getTestflightFeedback("shot-1").tester, "Jane Doe");
      assert.deepEqual(box.calls.map((call) => call.url), [
        "/api/listAgents", "/api/sendPrompt", "/api/listAgents", "/api/sendPrompt",
      ]);
      assert.match(box.calls[1].body.prompt, /TestFlight screenshot feedback from Jane Doe/);

      const second = await desk.poll();
      assert.equal(second.stored, 0, "the same Apple ids made duplicate rows");
      assert.equal(box.calls.length, 4, "a duplicate poll announced rows again");
      assert.equal(apple.calls.filter((call) => /betaFeedback/.test(call.url)).length, 4, "both feedback endpoints were polled each time");
    });
  } finally {
    await apple.close();
    await box.close();
  }
});

test("new and seen are the only states, and feedback.notify turns all pings off", async () => {
  await fixture(async ({ store }) => {
    assert.deepEqual(TESTFLIGHT_FEEDBACK_STATES, ["new", "seen"]);
    store.recordTestflightFeedback({ id: "one", receivedAt: 1, kind: "screenshot" });
    assert.equal(store.setTestflightFeedbackState("one", "seen").state, "seen");
    assert.throws(() => store.setTestflightFeedbackState("one", "closed"), /new, seen/);
    store.setSetting(FEEDBACK_NOTIFY_SETTING, "0");
    let calls = 0;
    const notify = createFeedbackNotifier({ store, probeImpl: async () => { calls += 1; } });
    const answer = await notify({ source: "in-app", id: 9, tenant: "demo", title: "broken" });
    assert.equal(answer.ok, false);
    assert.match(answer.why, /feedback\.notify is off/);
    assert.equal(calls, 0);
  });
});

test("a newly accepted in-app report makes the same one roster read and one prompt", async () => {
  const box = await startJsonServer((call) => {
    if (call.url === "/api/listAgents") return { body: { agents: [{ id: "titan-1", name: "Titan", isGroup: false }] } };
    if (call.url === "/api/sendPrompt") return { body: { accepted: true } };
    return { status: 404, body: {} };
  });
  const relayToken = "r".repeat(40);
  const plane = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken, CP_BOX_URL_OVERRIDE: box.url } });
  try {
    plane.store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
    plane.store.db.prepare("UPDATE tenants SET box_container = ? WHERE slug = ?").run("titanbot-box-svc", "titanium");
    const account = plane.store.createAccount({ email: "boss@example.com", password: "a-good-password", tenant: "titanium" });
    plane.store.setSuperAdmin(account.id, true);
    const profile = path.join(plane.config.tenantRoot, "titanium", "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "local-docker-vm.json"), JSON.stringify({ token: "gateway-token" }), { mode: 0o600 });
    const answer = await plane.request("POST", "/v1/feedback", {
      token: relayToken,
      headers: { "x-titanbot-tenant": "titanium" },
      body: { version: 1, tier: "quality", title: "The button moved", description: "It moved under the keyboard.", evidence: {} },
    });
    assert.equal(answer.status, 201, answer.text);
    assert.deepEqual(box.calls.map((call) => call.url), ["/api/listAgents", "/api/sendPrompt"]);
    assert.match(box.calls[1].body.prompt, /New in-app feedback from titanium: The button moved/);
  } finally {
    await plane.dispose();
    await box.close();
  }
});

test("a report Titan filed himself does not come back to him as news", async () => {
  const box = await startJsonServer((call) => {
    if (call.url === "/api/listAgents") return { body: { agents: [{ id: "titan-1", name: "Titan", isGroup: false }] } };
    if (call.url === "/api/sendPrompt") return { body: { accepted: true } };
    return { status: 404, body: {} };
  });
  const relayToken = "r".repeat(40);
  const plane = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken, CP_BOX_URL_OVERRIDE: box.url } });
  try {
    plane.store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
    plane.store.db.prepare("UPDATE tenants SET box_container = ? WHERE slug = ?").run("titanbot-box-svc", "titanium");
    const account = plane.store.createAccount({ email: "boss@example.com", password: "a-good-password", tenant: "titanium" });
    plane.store.setSuperAdmin(account.id, true);
    const profile = path.join(plane.config.tenantRoot, "titanium", "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "local-docker-vm.json"), JSON.stringify({ token: "gateway-token" }), { mode: 0o600 });
    const answer = await plane.request("POST", "/v1/feedback", {
      token: relayToken,
      headers: { "x-titanbot-tenant": "titanium" },
      body: { version: 1, tier: "quality", title: "Speaker toggle test result", description: "Filed by Titan.", evidence: { agent: "titan-1", agentName: "Titan" } },
    });
    assert.equal(answer.status, 201, answer.text);
    assert.deepEqual(box.calls.map((call) => call.url), ["/api/listAgents"], "the roster is read, and no prompt goes back to the bot that filed it");
  } finally {
    await plane.dispose();
    await box.close();
  }
});

test("the admin route lists TestFlight rows and marks one seen", async () => {
  const plane = await startControlPlane();
  try {
    plane.store.recordTestflightFeedback({ id: "apple-1", receivedAt: 1000, comment: "Hard to tap", kind: "screenshot" });
    const listed = await plane.admin("GET", "/v1/admin/testflight?state=new");
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.rows[0].id, "apple-1");
    assert.equal(listed.body.counts.new, 1);
    const seen = await plane.admin("POST", "/v1/admin/testflight/apple-1/seen", {});
    assert.equal(seen.status, 200, seen.text);
    assert.equal(seen.body.row.state, "seen");
  } finally { await plane.dispose(); }
});

test("the Feedback panel source names and TestFlight route are present", async () => {
  const fs = await import("node:fs");
  const js = fs.readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.js"), "utf8");
  const css = fs.readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.css"), "utf8");
  const admin = fs.readFileSync(path.join(import.meta.dirname, "../cp/admin.mjs"), "utf8");
  assert.match(js, /"In-app"/);
  assert.match(js, /"TestFlight"/);
  assert.match(js, /renderTestflightCard/);
  assert.match(css, /sourceChip/);
  assert.match(admin, /rest\[0\] === "testflight"/);
});
