// A proxy that is not a proxy, for the control plane's tests and for the tenant leg of
// scripts/verify-proxy.mjs.
//
// It is a real http server on a real port rather than an injected fetch, for the same reason
// startFakeCoolify is: what has to be measured is the request that goes on the wire, headers and
// all. A client that verified its own Authorization header against itself would prove nothing, and
// the one assertion that matters most here is that the MASTER key opens this thing and a tenant's
// virtual key does not.
//
// It answers the six routes cp/proxy.mjs uses, in the shapes LiteLLM answers them in:
//
//   GET  /health/readiness         {status, litellm_version}
//   GET  /model/info               {data: [{model_name, model_info: {max_input_tokens}}]}
//   GET  /v1/models                {data: [{id}]}
//   POST /key/generate             {key, token_id}
//   GET  /key/info?key=            {info: {key_alias, spend, max_budget, soft_budget}}
//   POST /key/delete               {deleted_keys: [...]}
//   POST /key/update               {key, ...}
//   GET  /global/spend/report      [{api_key, key_alias, total_spend, total_requests, ...}]
//
// And it does the one thing a stub has to do to be worth having: it enforces the door. Anything
// but the master key on an admin route is a 401, and a chat completion is refused unless the key
// presented is one this server actually minted and the model is one it actually serves.
import http from "node:http";

// The same list as deploy/coolify/proxy-config/config.yaml's general_settings.allowed_routes.
// A literal rather than something read out of the YAML: the gate has to FAIL when the two drift.
const ALLOWED_ROUTES = new Set([
  "/v1/chat/completions", "/chat/completions", "/v1/models", "/models",
  "/tinyfish/fetch", "/tinyfish/search", "/mcp", "/mcp/",
  "/key/generate", "/key/info", "/key/update", "/key/delete",
  "/model/info", "/spend/logs", "/health/readiness", "/health/liveness",
]);

export async function startFakeProxy(options = {}) {
  const masterKey = options.masterKey ?? "sk-master-for-a-test-only";
  // The pool the design pins: two Z.AI subscriptions under one model_name is two model_list entries
  // and one name, which is why the same string appears twice and the served list de-duplicates it.
  const served = options.models ?? [
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-minimax", model_info: { max_input_tokens: 1_000_000 } },
  ];

  const calls = [];
  const keys = new Map();
  // One row per request, the way LiteLLM's own /spend/logs answers.
  const logs = [];
  const nowIso = () => new Date().toISOString();      // key value -> record
  const byAlias = new Map();   // alias -> key value
  const failures = new Map();  // route -> queued failures
  let minted = 0;

  // `body` overrides the plain {error:{message}} shape, because LiteLLM's own enterprise refusals
  // come back as {detail: {error: "<a sentence>"}} and the extractor in cp/proxy.mjs once read past
  // that to the object and rendered "[object Object]" on every client's spend window. A stub that
  // can only produce one refusal shape cannot hold that regression.
  const failOnce = (route, status = 500, message = "the proxy said no", body = null) => {
    const queued = failures.get(route) ?? [];
    queued.push({ status, message, body });
    failures.set(route, queued);
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    const route = `${request.method} ${url.pathname}`;
    const authorization = String(request.headers.authorization ?? "");
    const presented = /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, "").trim() : "";

    let body = {};
    if (request.method !== "GET") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; } }
    }
    calls.push({ route, query: Object.fromEntries(url.searchParams), body, presented, at: Date.now() });

    const send = (status, payload) => {
      const text = JSON.stringify(payload ?? {});
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    };

    // The door list, applied BEFORE the credential, which is where the real proxy applies it
    // (pre_db_read_auth_checks in litellm/proxy/auth/auth_utils.py). One global list, so it refuses
    // the master key too. It is what closes GET /health: a route a tenant's own virtual key could
    // call, which makes a live call to every provider deployment on the operator's subscriptions.
    // MEASURED ON THE R750 2026-09-08 before the list existed: one sweep of /health left three rows
    // in /spend/logs under `litellm-internal-health-check`, $0.000043, charged to the operator and
    // attributed to no tenant. The list is a literal here and in
    // deploy/coolify/proxy-config/config.yaml, so the gate fails when the two drift.
    if (!ALLOWED_ROUTES.has(url.pathname) && !url.pathname.startsWith("/tinyfish/") && !url.pathname.startsWith("/mcp")) {
      return send(403, { error: { message: `Access forbidden: Route ${url.pathname} not allowed` } });
    }

    const queued = failures.get(route);
    if (queued && queued.length > 0) {
      const next = queued.shift();
      return send(next.status, next.body ?? { error: { message: next.message } });
    }

    // The inference door: a minted key, and only a model it was minted for. The operator's master
    // key is deliberately NOT accepted here, because "a request with the operator key from a box is
    // refused" is one of the things the gate has to prove and a stub that accepted it would make
    // that assertion meaningless.
    if (route === "POST /v1/chat/completions" || route === "POST /chat/completions") {
      const record = keys.get(presented);
      if (record == null) return send(401, { error: { message: "Invalid proxy server token passed" } });
      const model = String(body?.model ?? "");
      if (!record.models.includes(model)) return send(400, { error: { message: `key not allowed to access model ${model}` } });
      if (record.maxBudget !== null && record.spend >= record.maxBudget) {
        return send(400, { error: { message: `Budget has been exceeded! Current cost: ${record.spend}, Max budget: ${record.maxBudget}` } });
      }
      record.spend += options.costPerRequest ?? 0.01;
      record.requests += 1;
      const perModel = record.perModel.get(model) ?? { requests: 0, dollars: 0 };
      perModel.requests += 1;
      perModel.dollars += options.costPerRequest ?? 0.01;
      record.perModel.set(model, perModel);
      logs.push({ api_key: record.keyId, key_alias: record.alias, spend: options.costPerRequest ?? 0.01, model, startTime: nowIso() });
      return send(200, { id: "chatcmpl-test", model, choices: [{ message: { role: "assistant", content: "measured" } }] });
    }

    // Everything else is an admin route and takes the master key alone.
    if (presented !== masterKey) return send(401, { error: { message: "Authentication Error, invalid master key" } });

    if (route === "GET /health/readiness") return send(200, { status: "connected", litellm_version: "1.100.0" });

    if (route === "GET /model/info") {
      return send(200, { data: served.map((row) => ({ model_name: row.model_name, model_info: row.model_info ?? {} })) });
    }

    if (route === "GET /v1/models" || route === "GET /models") {
      return send(200, { data: [...new Set(served.map((row) => row.model_name))].map((id) => ({ id })) });
    }

    if (route === "POST /key/generate") {
      minted += 1;
      const value = `sk-tenant-${minted}-${Math.random().toString(36).slice(2, 10)}`;
      const record = {
        key: value,
        keyId: `hashed-${minted}`,
        alias: String(body?.key_alias ?? ""),
        tags: Array.isArray(body?.tags) ? body.tags : [],
        models: Array.isArray(body?.models) ? body.models.map(String) : [],
        metadata: body?.metadata ?? {},
        rpmLimit: body?.rpm_limit ?? null,
        maxBudget: body?.max_budget ?? null,
        softBudget: body?.soft_budget ?? null,
        spend: 0,
        requests: 0,
        perModel: new Map(),
      };
      keys.set(value, record);
      if (record.alias) byAlias.set(record.alias, value);
      return send(200, { key: value, token_id: record.keyId, expires: null });
    }

    if (route === "GET /key/info") {
      const record = keys.get(String(url.searchParams.get("key") ?? ""));
      if (record == null) return send(400, { error: { message: "Key not found" } });
      return send(200, {
        key: record.key,
        info: {
          key_alias: record.alias, token: record.keyId, spend: record.spend,
          max_budget: record.maxBudget, soft_budget: record.softBudget, models: record.models,
        },
      });
    }

    if (route === "POST /key/delete") {
      const aliases = Array.isArray(body?.key_aliases) ? body.key_aliases.map(String) : [];
      const values = Array.isArray(body?.keys) ? body.keys.map(String) : [];
      const removed = [];
      for (const alias of aliases) {
        const value = byAlias.get(alias);
        if (value === undefined) continue;
        keys.delete(value); byAlias.delete(alias); removed.push(alias);
      }
      for (const value of values) {
        const record = keys.get(value);
        if (record == null) continue;
        keys.delete(value); if (record.alias) byAlias.delete(record.alias); removed.push(record.alias || value);
      }
      return send(200, { deleted_keys: removed });
    }

    if (route === "POST /key/update") {
      const record = keys.get(String(body?.key ?? ""));
      if (record == null) return send(400, { error: { message: "Key not found" } });
      if (body?.max_budget !== undefined) record.maxBudget = body.max_budget;
      if (body?.soft_budget !== undefined) record.softBudget = body.soft_budget;
      if (body?.rpm_limit !== undefined) record.rpmLimit = body.rpm_limit;
      if (Array.isArray(body?.models)) record.models = body.models.map(String);
      return send(200, { key: record.key, max_budget: record.maxBudget, soft_budget: record.softBudget });
    }

    // MEASURED ON THE R750 2026-09-08 against docker.litellm.ai/berriai/litellm-database:v1.100.0,
    // which is the build this product runs: /global/spend/report is ENTERPRISE ONLY and answers 400
    // with that sentence. This stub refuses it the same way, so nothing can be built on it again
    // and pass here while failing on the server.
    if (route === "GET /global/spend/report") {
      return send(400, { detail: { error: "/spend/report endpoint You must be a LiteLLM Enterprise user to use this feature." } });
    }

    // What the open build does answer: one row per REQUEST, which is where both spend windows and
    // the per model breakdown are computed from.
    if (route === "GET /spend/logs") return send(200, logs);

    return send(404, { error: { message: `no route ${route} on this stub` } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    masterKey,
    calls,
    failOnce,
    callsTo: (route) => calls.filter((call) => call.route === route),
    keyCount: () => keys.size,
    keyByAlias: (alias) => keys.get(byAlias.get(alias)) ?? null,
    /** Spend put on a key without a request, for the panel assertions. */
    chargeAlias(alias, dollars, requests = 1, model = "plan-zai") {
      const record = keys.get(byAlias.get(alias));
      if (record == null) return false;
      record.spend += dollars;
      record.requests += requests;
      const perModel = record.perModel.get(model) ?? { requests: 0, dollars: 0 };
      perModel.requests += requests;
      perModel.dollars += dollars;
      record.perModel.set(model, perModel);
      for (let i = 0; i < requests; i += 1) {
        logs.push({ api_key: record.keyId, key_alias: record.alias, spend: dollars / requests, model, startTime: nowIso() });
      }
      return true;
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
