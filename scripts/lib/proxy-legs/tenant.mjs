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
import { createHash } from "node:crypto";
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
async function startFakeRelay(token, tenantRoot = "") {
  const calls = [];
  // What the real relay writes into a box is the key IT holds, from its own registry, which lags
  // the control plane by a refresh. In the happy path that equals the file the mint wrote, so this
  // stub reports the hash of that file. `staleKey` forces the lagging case the CLI has to catch.
  let staleKey = null;
  const keyHashFor = (slug) => {
    if (staleKey != null) return createHash("sha256").update(staleKey, "utf8").digest("hex").slice(0, 12);
    try {
      const raw = readFileSync(path.join(tenantRoot, slug, "profile", "model-proxy.json"), "utf8");
      return createHash("sha256").update(String(JSON.parse(raw).key ?? ""), "utf8").digest("hex").slice(0, 12);
    } catch { return ""; }
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; } }
    const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    calls.push({ route: `${request.method} ${url.pathname}`, body, authorized: presented === token });
    const slug = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const text = JSON.stringify({
      // What it wrote, by hash prefix and never by value. The CLI compares this against the key it
      // just minted, so a console still serving an older key is caught instead of being written
      // into somebody's box.
      wrote: [{ name: "SAND_OPENAI_COMPATIBLE_API_KEY", length: 25, sha256: keyHashFor(slug) }],
      // The relay's real answer shape, so this stub cannot drift from the route the CLI talks to:
      // `prefix` in, a `removed` ARRAY and a `removedCount` out, plus the absence proof.
      endpointName: "Z.AI GLM (included with your plan)",
      using: "plan-zai",
      removed: body?.prefix ? [{ file: "box-secrets.json", name: "SAND_OPENAI_COMPATIBLE_API_KEY", length: 113, sha256: "734e60c2f9de" }] : [],
      removedCount: body?.prefix ? 1 : 0,
      remaining: [{ where: "connector-env-secrets.json", name: "TINYFISH_API_KEY", length: 44, sha256: "9165ce2daa86" }],
    });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    /** Pretend the registry has not refreshed yet, the way it had not on the R750. */
    serveStaleKey: (key) => { staleKey = key; },
    serveCurrentKey: () => { staleKey = null; },
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
  const relay = await startFakeRelay("r".repeat(32), path.join(root, "tenants"));

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

    // PROXY-8, closed on the KEY rather than on the file.
    //
    // MEASURED ON THIS MAC 2026-09-08 against docker.litellm.ai/berriai/litellm-database:v1.100.0:
    // a key minted with allowed_routes answers 403 "Virtual key is not allowed to call this route"
    // on every admin path, while chat completions and /v1/models keep working and the master key is
    // unaffected. Before this wave those paths were open to every virtual key on the bridge,
    // because ONE global list in the proxy's config had to keep /key/info and /model/info open for
    // the control plane, and a list checked before the key is looked up cannot tell the two apart.
    await record("a virtual key opens no admin route and reads nobody's spend", async () => {
      const key = readProxyKey("acme", config).key;
      const refused = [];
      for (const pathname of [
        `/key/info?key=${encodeURIComponent(key)}`,
        "/model/info",
        "/model_group/info",
        "/spend/logs",
        "/health",
        "/global/spend/report?start_date=2026-09-01&end_date=2026-09-30",
      ]) {
        const answer = await fetch(`${proxy.url}${pathname}`, { headers: { authorization: `Bearer ${key}` } });
        assert.equal(answer.status, 403, `a virtual key opened ${pathname} (HTTP ${answer.status})`);
        const said = String((await answer.json())?.error?.message ?? "");
        assert.match(said, /not allowed to call this route/, `${pathname} was refused for the wrong reason`);
        refused.push(pathname);
      }
      return `${refused.length} admin routes, 403 on every one, with the key's own route list named`;
    });

    // THE OTHER HALF OF MOVING THE DOOR: the operator keeps working.
    //
    // MEASURED ON THE R750 2026-09-08, from inside a customer's box with that customer's own
    // virtual key: `GET /health` answered 200 with healthy_endpoints populated, so the calls were
    // actually made to every provider on the operator's subscriptions -- free to that tenant,
    // charged to the operator, attributed to nobody, and a rate-limit amplifier against a shared
    // plan. One admin sweep of the same route left three rows in /spend/logs under the alias
    // `litellm-internal-health-check` at $0.000043.
    //
    // Until this wave that was closed by ONE GLOBAL LIST in the proxy's config, which refused the
    // route to the master key as well and could not be written for the panel's two path-parameter
    // routes at all. The list is gone; the refusal above is per key. So what is asserted here is
    // that the same paths the tenant was refused still answer for the OPERATOR, because a boundary
    // that also locks out the thing that manages the fleet is not a boundary, it is an outage.
    await record("the same routes still answer for the operator", async () => {
      const opened = [];
      for (const pathname of ["/model/info", "/model_group/info", "/spend/logs", "/credentials"]) {
        const answer = await fetch(`${proxy.url}${pathname}`, { headers: { authorization: `Bearer ${proxy.masterKey}` } });
        assert.equal(answer.status, 200, `${pathname} is closed to the operator (HTTP ${answer.status})`);
        opened.push(pathname);
      }
      // And one that is refused for a reason of its own rather than by a door: the enterprise gate,
      // which is what the spend panel was once built on.
      const enterprise = await fetch(`${proxy.url}/global/spend/report`, { headers: { authorization: `Bearer ${proxy.masterKey}` } });
      assert.equal(enterprise.status, 400, "the enterprise report answered something other than its own refusal");
      return `${opened.length} admin routes open to the master key, and the enterprise report refused on its own terms`;
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

    await record("a console still serving an older key is caught, and nothing is deleted", async () => {
      // MEASURED ON THE R750 2026-09-08. demo's key was revoked and minted again, and the migrate
      // that followed reported "the box now answers through the plan" while writing the REVOKED key
      // back into the box, because the relay refreshes its registry about once a minute and that is
      // still what it held. The box answered 401 on every turn and the command that caused it had
      // said it worked. The relay names what it wrote by hash, so the two are compared.
      relay.serveStaleKey("sk-a-key-that-was-revoked-a-minute-ago");
      try {
        const before = relay.calls.filter((call) => call.route.endsWith("/forget-provider-keys")).length;
        const answer = await runCli(["proxy", "migrate", "legacy", "--forget", "734e60c2"], { ...env, CP_PROXY_SWITCH_WAIT_MS: "1500" });
        assert.match(answer.stdout, /still (handing out|on) an older key/);
        assert.match(answer.stdout, /Nothing was deleted/);
        const after = relay.calls.filter((call) => call.route.endsWith("/forget-provider-keys")).length;
        assert.equal(after, before, "a migrate that could not confirm the key still deleted one");
      } finally { relay.serveCurrentKey(); }
      return "the stale key was refused and nothing was deleted";
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
      assert.deepEqual(sent.body, { prefix: "734e60c2" });
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
