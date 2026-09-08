// The tenant leg of scripts/verify-proxy.mjs (PROXY-1, item B).
//
// What this leg proves, end to end, against a proxy that is not a proxy and a Coolify that is not
// Coolify: that one customer gets one key, that the key is theirs alone, that it can be taken away,
// and that nothing anywhere hands it to somebody it does not belong to.
//
// Every check below is a thing that would be silent if it broke:
//
//   mint once        a retry that mints a second key leaves the box on the first and the registry
//                    on the second, and the only symptom is a 401 nobody can explain
//   the eighth step  demo and richard-avery have the other seven marked ok on the R750, so a step
//                    folded into an existing one would never run for either of them
//   the door         the operator's own key opening inference from a box is exactly the thing this
//                    whole wave ends
//   spend            a report joined on the wrong handle bills one customer for another's month
//   revoke first     a key removed AFTER a failed container delete leaves a customer's box running
//                    with a credential the operator believes they took away
//   the forget       the migration deletes only what it was given the hash of, so it can never take
//                    a customer's own key
//
// It runs standalone as well as under the gate, because a leg that can only run inside a harness
// that does not exist yet is a leg nobody has measured:
//
//   node scripts/lib/proxy-legs/tenant.mjs
//
// Exit 0 every check passed, 1 a check failed. It needs no docker, no network and no box.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, createHttpServer } from "../../../cp/server.mjs";
import {
  ensureProxyKey,
  loadConfig,
  provisionTenant,
  provisioningPlan,
  readProxyKey,
  tenantPaths,
} from "../../../cp/provision.mjs";
import { createProxyClient } from "../../../cp/proxy.mjs";
import { openStore } from "../../../cp/store.mjs";
import { startFakeCoolify } from "../../../tests/cp-support.mjs";
import { startFakeProxy } from "../../../tests/cp-proxy-support.mjs";

export const name = "tenant";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A relay that records what the CLI asked it to do to a box, and does nothing to one. */
async function startFakeRelay(token) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; } }
    const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    calls.push({ route: `${request.method} ${url.pathname}`, body, authorized: presented === token });
    const text = JSON.stringify({
      message: "switched",
      removed: body?.sha256Prefix ? 1 : 0,
      remaining: [{ where: "connector-env-secrets.json", name: "TINYFISH_API_KEY", length: 44, sha256: "9165ce2daa8600000000" }],
    });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** cp/cli.mjs, run the way an operator runs it inside the control plane container. */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "cp", "cli.mjs"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The leg.
 *
 * `log` is taken from the harness when there is one so the gate's own output stays in one voice,
 * and falls back to stdout when this file is run on its own.
 */
export async function run(context = {}) {
  const log = context.log ?? ((line) => process.stdout.write(`${line}\n`));
  const checks = [];
  const record = async (title, body) => {
    const started = Date.now();
    try {
      const detail = await body();
      checks.push({ name: title, ok: true, detail: detail ?? "", ms: Date.now() - started });
      log(`  ok    ${title}${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      checks.push({ name: title, ok: false, detail: String(error?.message ?? error).split("\n")[0], ms: Date.now() - started });
      log(`  FAIL  ${title}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  };

  const root = await mkdtemp(path.join(os.tmpdir(), "proxy-leg-tenant-"));
  const proxy = await startFakeProxy();
  const coolify = await startFakeCoolify();
  const relay = await startFakeRelay("r".repeat(32));

  const env = {
    CP_PORT: "0",
    CP_DATA_DIR: path.join(root, "data"),
    CP_SESSION_SECRET: "s".repeat(48),
    CP_ADMIN_TOKEN: "a".repeat(32),
    CP_RELAY_TOKEN: "r".repeat(32),
    CP_RELAY_URL: relay.url,
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: path.join(root, "release"),
    CP_PUBLIC_URL: "https://api.titanium.bot",
    COOLIFY_URL: coolify.url,
    COOLIFY_API_KEY: coolify.apiKey,
    COOLIFY_PROJECT_UUID: "project-uuid-1",
    COOLIFY_SERVER_UUID: "server-uuid-1",
    COOLIFY_ENVIRONMENT_NAME: "production",
    CP_ALLOW_NEW_TENANTS: "1",
    CP_BOX_READY_TIMEOUT_MS: "40",
    CP_BOX_READY_INTERVAL_MS: "10",
    CP_PROXY_URL: proxy.url,
    CP_PROXY_MASTER_KEY: proxy.masterKey,
    CP_PROXY_ALLOWANCE_USD: "20",
  };
  const config = loadConfig(env);
  const store = openStore({ dataDir: config.dataDir });
  const app = createApp({ config, store, probeImpl: () => { throw new Error("there is no docker network in a gate"); } });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = async (method, pathname, body) => {
    const init = { method, headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" } };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const answer = await fetch(`${base}${pathname}`, init);
    const text = await answer.text();
    return { status: answer.status, text, body: text.length > 0 ? JSON.parse(text) : null };
  };

  log(`${name}: a control plane, a proxy and a Coolify, all of them on this machine`);

  try {
    // ---- one customer, built the whole way through -------------------------------------------
    await record("a new workspace mints exactly one key, at the eighth step", async () => {
      const created = await admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing" });
      assert.equal(created.status, 201, created.text);
      const steps = store.listSteps("acme").map((step) => `${step.step}:${step.status}`);
      assert.ok(steps.includes("proxy-key:ok"), `proxy-key did not run: ${steps.join(", ")}`);
      assert.deepEqual(provisioningPlan({ slug: "acme", name: "Acme", config }).map((step) => step.name),
        ["directories", "secrets", "compose", "service", "envs", "proxy-key", "start", "ready"]);
      assert.equal(proxy.callsTo("POST /key/generate").length, 1);
      return "1 key, step 6 of 8";
    });

    await record("a retry reads the key back rather than minting a second", async () => {
      const before = proxy.callsTo("POST /key/generate").length;
      const record = readProxyKey("acme", config);
      const again = await admin("POST", "/v1/tenants/acme/provision");
      assert.equal(again.status, 200, again.text);
      assert.equal(proxy.callsTo("POST /key/generate").length, before, "a retry minted a second key");
      assert.equal(readProxyKey("acme", config).key, record.key);
      return `${proxy.callsTo("POST /key/generate").length} POST /key/generate over two runs`;
    });

    await record("the eighth step runs for a workspace whose other seven are already ok", async () => {
      // This is the shape both live customers are in on the R750.
      store.createTenant({ slug: "legacy", name: "Legacy", host: "console.titanium.bot" });
      for (const directory of [path.join(config.tenantRoot, "legacy"), path.join(config.tenantRoot, "legacy", "profile")]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      for (const step of ["directories", "secrets", "compose", "service", "envs", "start", "ready"]) {
        store.recordStep({ slug: "legacy", step, status: "ok", detail: "{}" });
      }
      store.updateTenant("legacy", { coolifyServiceUuid: "svc-legacy", boxContainer: "titanbot-box-svc-legacy" });
      const result = await provisionTenant({ store, config, slug: "legacy", name: "Legacy", probeImpl: () => { throw new Error("no network"); } });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.ran, ["proxy-key"]);
      return "only proxy-key ran";
    });

    // ---- the door ------------------------------------------------------------------------------
    await record("a box's own key reaches a plan model and the operator's key is refused", async () => {
      const key = readProxyKey("acme", config).key;
      const ask = (bearer) => fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "plan-zai", messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal((await ask(key)).status, 200, "the tenant's own key could not reach its plan model");
      // THE THING THIS WAVE ENDS.
      assert.equal((await ask(proxy.masterKey)).status, 401, "the operator's key still opens inference");
      return "200 for the tenant, 401 for the operator";
    });

    await record("a virtual key opens no admin route and reads nobody's spend", async () => {
      const key = readProxyKey("acme", config).key;
      for (const pathname of ["/key/info?key=" + encodeURIComponent(key), "/global/spend/report?start_date=2026-09-01&end_date=2026-09-30", "/model/info"]) {
        const answer = await fetch(`${proxy.url}${pathname}`, { headers: { authorization: `Bearer ${key}` } });
        assert.equal(answer.status, 401, `a virtual key opened ${pathname}`);
      }
      return "3 admin routes, 401 on every one";
    });

    // ---- spend ---------------------------------------------------------------------------------
    await record("spend lands against that alias and against nobody else", async () => {
      const second = await admin("POST", "/v1/tenants", { slug: "beta", name: "Beta" });
      assert.equal(second.status, 201, second.text);
      // Acme has already paid for the one real request the door check sent through their key, so
      // what is asserted is the DELTA. A gate that assumed a clean slate would either be wrong or
      // would quietly stop noticing the request that came before it.
      const before = proxy.keyByAlias("titanbot-acme").spend;
      proxy.chargeAlias("titanbot-acme", 5, 10);
      const answer = await admin("GET", "/v1/admin/spend");
      assert.equal(answer.status, 200, answer.text);
      const acme = answer.body.clients.find((row) => row.slug === "acme");
      const beta = answer.body.clients.find((row) => row.slug === "beta");
      assert.equal(Number((acme.thisMonth.dollars - before).toFixed(2)), 5, "the five dollars did not land on acme");
      assert.equal(acme.pct, Math.round((acme.thisMonth.dollars / 20) * 100), "the percentage is not what was spent over the allowance");
      assert.equal(beta.thisMonth.dollars, 0, "the neighbour was charged for it");
      // And no key came out with it.
      assert.equal(answer.text.includes(readProxyKey("acme", config).key), false, "the spend panel carried a live key");
      return `acme $${acme.thisMonth.dollars.toFixed(2)} at ${acme.pct}%, beta $0`;
    });

    await record("observe mode mints a soft budget, enforce mints a hard one", async () => {
      const observed = proxy.callsTo("POST /key/generate")[0].body;
      assert.equal(observed.soft_budget, 20);
      assert.equal(Object.hasOwn(observed, "max_budget"), false);

      const armed = loadConfig({ ...env, CP_PROXY_ENFORCE: "1", CP_TENANT_ROOT: path.join(root, "armed") });
      mkdirSync(tenantPaths("armed", armed).profile, { recursive: true, mode: 0o700 });
      const minted = await ensureProxyKey("armed", armed);
      assert.equal(minted.ok, true, minted.why);
      const sent = proxy.callsTo("POST /key/generate").at(-1).body;
      assert.equal(sent.max_budget, 20);
      assert.equal(Object.hasOwn(sent, "soft_budget"), false);
      return "soft_budget 20 observing, max_budget 20 armed";
    });

    // ---- taking it away --------------------------------------------------------------------------
    await record("removing a workspace revokes the key BEFORE it deletes the container", async () => {
      await admin("POST", "/v1/tenants/beta/stop");
      // The order, proved by breaking the second half: if the revoke ran second, a failed container
      // delete would leave the box running with a credential the operator thinks is gone.
      coolify.failOnce("DELETE /services/{uuid}", 500, "Coolify is busy");
      const broken = await admin("DELETE", "/v1/tenants/beta", { confirm: "beta" });
      assert.equal(broken.status, 502);
      assert.equal(proxy.keyByAlias("titanbot-beta"), null, "the key survived a failed container delete");
      const done = await admin("DELETE", "/v1/tenants/beta", { confirm: "beta" });
      assert.equal(done.status, 200, done.text);
      return "key gone, container delete retried";
    });

    await record("a revoked key is refused at the proxy, and the seconds are measured", async () => {
      const key = readProxyKey("acme", config).key;
      const ask = () => fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "plan-zai", messages: [] }),
      });
      assert.equal((await ask()).status, 200);
      const started = Date.now();
      const revoked = await createProxyClient({ config }).deleteKeyByAlias("acme");
      assert.equal(revoked.ok, true);
      let status = 0;
      // Measured at the PROXY. The relay deliberately keeps its last good registry answer, so a
      // relay that has stopped serving a row is never evidence that a key was revoked.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        status = (await ask()).status;
        if (status === 401) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(status, 401, "a revoked key still reached a model");
      const seconds = ((Date.now() - started) / 1000).toFixed(2);
      // THIS MACHINE AND THIS STUB. The stub holds no key cache, so this number is the round trip
      // and not the real one. On the R750 the number that matters is user_api_key_cache_ttl, which
      // this design pins EXPLICITLY at 30 rather than leaving at LiteLLM's default of 60, because
      // "revocation within a minute" is otherwise satisfied by luck.
      return `refused ${seconds} s after the delete, on this Mac against the stub (no key cache); the R750 number is user_api_key_cache_ttl, pinned at 30 s`;
    });

    // ---- the migration ---------------------------------------------------------------------------
    await record("migrate --dry-run writes nothing and touches no box", async () => {
      const before = relay.calls.length;
      const answer = await runCli(["proxy", "migrate", "legacy", "--dry-run", "--forget", "734e60c2"], env);
      assert.equal(answer.code, 0, answer.stderr);
      assert.match(answer.stdout, /nothing was written/);
      assert.match(answer.stdout, /734e60c2/);
      assert.equal(relay.calls.length, before, "a dry run reached the relay");
      // And the key it says it would reuse is still the one that was there.
      assert.ok(existsSync(tenantPaths("legacy", config).proxyKeyFile));
      return "0 relay calls";
    });

    await record("migrate refuses to delete a hash it was not given", async () => {
      const before = relay.calls.filter((call) => call.route.endsWith("/forget-provider-keys")).length;
      const answer = await runCli(["proxy", "migrate", "legacy"], env);
      assert.equal(answer.code, 0, answer.stderr);
      // No --forget prefix, so nothing is deleted and it says so. Matching on the hash is what makes
      // it impossible for this to take a customer's own key by accident: the only thing it can
      // remove is a value somebody already proved they knew.
      assert.match(answer.stdout, /nothing was deleted/);
      const after = relay.calls.filter((call) => call.route.endsWith("/forget-provider-keys")).length;
      assert.equal(after, before, "a migrate with no hash prefix asked the relay to delete something");
      // With one, it sends exactly that prefix and nothing else.
      const armed = await runCli(["proxy", "migrate", "legacy", "--forget", "734e60c2"], env);
      assert.equal(armed.code, 0, armed.stderr);
      const sent = relay.calls.filter((call) => call.route.endsWith("/forget-provider-keys")).at(-1);
      assert.deepEqual(sent.body, { sha256Prefix: "734e60c2" });
      assert.equal(sent.authorized, true, "the relay route was opened without the relay's own credential");
      return "no prefix, no delete; with one, exactly that prefix";
    });

    await record("proxy list names every workspace and prints no key", async () => {
      const answer = await runCli(["proxy", "list"], env);
      assert.equal(answer.code, 0, answer.stderr);
      assert.match(answer.stdout, /titanbot-acme/);
      assert.match(answer.stdout, /titanbot-legacy/);
      for (const slug of ["acme", "legacy"]) {
        const key = readProxyKey(slug, config)?.key ?? "";
        if (key) assert.equal(answer.stdout.includes(key), false, `proxy list printed ${slug}'s key`);
      }
      return "2 workspaces, 0 keys printed";
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await relay.close();
    await coolify.close();
    await proxy.close();
    await rm(root, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.ok);
  log(`${name}: ${checks.length - failed.length} of ${checks.length} checks passed`);
  return { name, ok: failed.length === 0, checks };
}

export default { name, run };

// Standalone. A leg that can only run inside a harness nobody has built yet is a leg nobody has
// measured, so this file is its own entry point too.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const answer = await run();
  process.exit(answer.ok ? 0 : 1);
}
