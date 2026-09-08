// A proxy that is not a proxy, for the control plane's tests and for the tenant leg of
// scripts/verify-proxy.mjs.
//
// It is a real http server on a real port rather than an injected fetch, for the same reason
// startFakeCoolify is: what has to be measured is the request that goes on the wire, headers and
// all. A client that verified its own Authorization header against itself would prove nothing, and
// the one assertion that matters most here is that the MASTER key opens this thing and a tenant's
// virtual key does not.
//
// It answers the routes cp/proxy.mjs uses, in the shapes LiteLLM answers them in:
//
//   GET  /health/readiness         {status, litellm_version}
//   GET  /model/info               {data: [{model_name, litellm_params, model_info}]}
//   GET  /model_group/info         {data: [{model_group, max_input_tokens, supports_vision}]}
//   POST /model/new                strictly create; a duplicate model_info.id is a 500
//   POST /model/update             merges; a model_info-only body is a 400
//   PATCH /model/{id}/update       the model_info-only edit POST refuses
//   POST /model/delete             {id}
//   GET  /credentials              {credentials: [...]}, api_key MASKED
//   POST /credentials              a key stored
//   PATCH /credentials/{name}      the zero-gap roll; 422 without credential_name in the BODY too
//   DELETE /credentials/{name}
//   GET/POST/DELETE /fallback      one alias at a time; GET with no model is a 405
//   GET/POST/DELETE /config/pass_through_endpoint
//   GET  /health?model_id=         one deployment asked whether it answers
//   GET  /health/latest            what the last check said
//   POST /key/generate             {key, token_id}
//   GET  /key/info?key=            {info: {key_alias, spend, max_budget, soft_budget}}
//   POST /key/delete               {deleted_keys: [...]}
//   POST /key/update               a budget, a model list or a ROUTE LIST on a key that exists
//   GET  /global/spend/report      the enterprise refusal, on purpose
//   GET  /spend/logs               one row per request
//
// PROVIDERS-1 CHANGED THE DOOR, AND THIS STUB CHANGED WITH IT. There used to be a literal copy of
// general_settings.allowed_routes here, one global list checked before the credential, which is
// where the real proxy checks it and which is exactly why PROXY-8 was open: one list cannot tell a
// tenant from the operator, so /key/info and /model/info had to stay open to every box on the
// bridge because the control plane called them. The boundary is now on the KEY. A key minted with
// allowed_routes is refused anything outside them with LiteLLM's own sentence; the master key is
// unrestricted, which is what the real proxy does and what the panel needs.
//
// The sharp edges below are deliberately duplicated from item A's stub rather than shared, so a
// drift between the two FAILS A GATE instead of passing quietly on both sides.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

// LiteLLM's own refusal, word for word, because cp/proxy.mjs reads it and a paraphrase here would
// let a parser that only works against this stub ship.
const NOT_ALLOWED = (pathname, allowed) =>
  `Virtual key is not allowed to call this route. Only allowed to call routes: ${JSON.stringify(allowed)}. Tried to call route: ${pathname}`;

// What LiteLLM says when a deployment write lands on a proxy whose flag is off. MEASURED ON THIS
// MAC 2026-09-08: the deployment half refuses and the credential half answers 200 and persists,
// which is the half-state a seed has to refuse to start on.
const DB_OFF = "Set 'STORE_MODEL_IN_DB='True' in your env to enable this feature.";

// The mask the proxy itself puts on a stored key. Never something a caller computes.
const maskOf = (value) => {
  const text = String(value ?? "");
  if (text.length <= 6) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
};

export async function startFakeProxy(options = {}) {
  const masterKey = options.masterKey ?? "sk-master-for-a-test-only";
  // The pool the design pins: two Z.AI subscriptions under one model_name is two model_list entries
  // and one name, which is why the same string appears twice and the served list de-duplicates it.
  const served = options.models ?? [
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-zai", model_info: { max_input_tokens: 200_000 } },
    { model_name: "plan-minimax", model_info: { max_input_tokens: 1_000_000 } },
  ];
  // Whether deployment writes take. Off is the R750's state before stage 1 of the ship plan, and a
  // seed that ignored it would write half a configuration and report success.
  let storeModelInDb = options.storeModelInDb !== false;

  const calls = [];
  const keys = new Map();
  // One row per request, the way LiteLLM's own /spend/logs answers.
  const logs = [];
  const nowIso = () => new Date().toISOString();      // key value -> record
  const byAlias = new Map();   // alias -> key value
  const failures = new Map();  // route -> queued failures
  let minted = 0;

  // ---- the database the proxy would have -------------------------------------------------------
  const deployments = served.map((row, index) => ({
    model_name: String(row.model_name),
    litellm_params: { model: String(row.litellm_params?.model ?? `openai/${row.model_name}`), ...(row.litellm_params ?? {}) },
    model_info: { id: String(row.model_info?.id ?? `file-${index + 1}`), db_model: false, ...(row.model_info ?? {}) },
  }));
  const credentials = new Map();   // name -> {credential_name, credential_values, credential_info}
  const fallbacks = new Map();     // alias -> [aliases]
  const passThrough = new Map();   // id -> row
  const healthLatest = new Map();  // deployment id -> row
  // What a registered /catalog/<id> pass-through answers when it is reached. The point of the hop
  // is that the control plane holds no vendor key, so the stub proves the hop and not the vendor.
  const catalogs = options.catalogs ?? { zai: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"] };

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

    // ---- THE DOOR, NOW ON THE KEY --------------------------------------------------------------
    //
    // MEASURED ON THIS MAC 2026-09-08 against docker.litellm.ai/berriai/litellm-database:v1.100.0:
    // a key minted with allowed_routes ["/v1/chat/completions","/chat/completions","/v1/models",
    // "/models"] answers 403 with the sentence below on /key/info, /model/info, /model_group/info,
    // /health and /spend/logs, while chat completions and /v1/models keep working and the MASTER
    // key is unaffected. That is what closes PROXY-8 per key rather than globally, and it closes
    // /health to tenants at the same time -- a route a tenant could call that makes a live call to
    // every provider deployment on the operator's own subscriptions.
    //
    // The match is an exact string on the REGISTERED path, so the pass-throughs are listed rather
    // than matched by prefix, except for their subpaths, which is what include_subpath means.
    const holder = keys.get(presented);
    if (holder != null && holder.allowedRoutes.length > 0) {
      const allowed = holder.allowedRoutes.includes(url.pathname)
        || holder.allowedRoutes.some((one) => one.endsWith("/") && url.pathname.startsWith(one))
        || holder.allowedRoutes.some((one) => url.pathname.startsWith(`${one}/`));
      if (!allowed) return send(403, { error: { message: NOT_ALLOWED(url.pathname, holder.allowedRoutes) } });
    }

    const queued = failures.get(route);
    if (queued && queued.length > 0) {
      const next = queued.shift();
      return send(next.status, next.body ?? { error: { message: next.message } });
    }

    // ---- inference -----------------------------------------------------------------------------
    //
    // A minted key, and only a model it was minted for. The operator's master key is deliberately
    // NOT accepted for an ordinary request, because "a request with the operator key from a box is
    // refused" is one of the things the gate has to prove and a stub that accepted it would make
    // that assertion meaningless. It IS accepted for a request carrying an image part, which is the
    // Providers panel's vision check: that check is an operator action, it has no key of its own,
    // and on the real proxy the master key does open inference.
    if (route === "POST /v1/chat/completions" || route === "POST /chat/completions") {
      const model = String(body?.model ?? "");
      const carriesImage = (body?.messages ?? []).some((message) => Array.isArray(message?.content)
        && message.content.some((part) => String(part?.type ?? "") === "image_url"));
      const record = keys.get(presented);
      if (record == null && !(presented === masterKey && carriesImage)) {
        return send(401, { error: { message: "Invalid proxy server token passed" } });
      }
      if (record != null && !record.models.includes(model)) {
        return send(400, { error: { message: `key not allowed to access model ${model}` } });
      }
      const behind = deployments.filter((row) => row.model_name === model);
      if (behind.length === 0) return send(400, { error: { message: `Invalid model name passed in model=${model}` } });
      // THE VENDOR'S OWN REFUSAL, modelled. Measured 2026-09-08 against Z.AI's coding plan: glm-5.3
      // refuses an image part with code 1210 while glm-5.3-flash takes one. A plan model that
      // refuses images is a fleet-wide screenshot outage, which is what PROXY-10 cost, so the stub
      // has to be able to produce both answers.
      if (carriesImage && !behind.some((row) => row.model_info?.supports_vision === true)) {
        const target = fallbacks.get(model) ?? [];
        const rescue = target.map((alias) => deployments.filter((row) => row.model_name === alias)).find((rows) => rows.some((row) => row.model_info?.supports_vision === true));
        if (rescue == null) {
          return send(400, { error: { message: "messages.content.type is invalid, allowed values: ['text']", code: "1210" } });
        }
      }
      if (record != null && record.maxBudget !== null && record.spend >= record.maxBudget) {
        return send(400, { error: { message: `Budget has been exceeded! Current cost: ${record.spend}, Max budget: ${record.maxBudget}` } });
      }
      const cost = options.costPerRequest ?? 0.01;
      if (record != null) {
        record.spend += cost;
        record.requests += 1;
        const perModel = record.perModel.get(model) ?? { requests: 0, dollars: 0 };
        perModel.requests += 1;
        perModel.dollars += cost;
        record.perModel.set(model, perModel);
        logs.push({
          api_key: record.keyId, key_alias: record.alias, spend: cost, model, startTime: nowIso(),
          // Which deployment served it, which is what joins a spend row to a key slot. A pool is
          // several deployments under one alias, so the alias alone cannot say which subscription
          // paid, and that is the whole question the Providers panel's quota bars answer.
          model_id: behind[0].model_info.id,
          prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        });
      }
      return send(200, { id: "chatcmpl-test", model, choices: [{ message: { role: "assistant", content: "measured" } }] });
    }

    // ---- the pass-throughs ---------------------------------------------------------------------
    // Registered paths, reached with a virtual key or the master key. /catalog/<id> is how the
    // control plane reads a vendor's model list while holding no vendor key: the key rides on the
    // far side, in the row's headers.
    const passRow = [...passThrough.values()].find((row) => url.pathname === row.path
      || (row.include_subpath === true && url.pathname.startsWith(`${row.path}/`)));
    if (passRow != null) {
      if (presented !== masterKey && !keys.has(presented)) return send(401, { error: { message: "Invalid proxy server token passed" } });
      const provider = String(passRow.path).replace(/^\/catalog\//, "");
      const names = catalogs[provider];
      if (!Array.isArray(names)) return send(502, { error: { message: `nothing behind ${passRow.path} in this stub` } });
      // The vendor's OWN shape: names only. There is no context window and no vision flag in it,
      // which is why those two are things a person sets and why the panel says so.
      return send(200, { object: "list", data: names.map((id) => ({ id, object: "model", created: 0, owned_by: provider })) });
    }

    // Everything else is an admin route and takes the master key alone.
    if (presented !== masterKey) return send(401, { error: { message: "Authentication Error, invalid master key" } });

    if (route === "GET /health/readiness") return send(200, { status: "connected", litellm_version: "1.100.0" });

    if (route === "GET /model/info") {
      return send(200, { data: deployments.map((row) => ({ ...row, model_info: { ...row.model_info } })) });
    }

    if (route === "GET /model_group/info") {
      const groups = new Map();
      for (const row of deployments) {
        const seen = groups.get(row.model_name) ?? { model_group: row.model_name, max_input_tokens: null, supports_vision: false, providers: [] };
        seen.max_input_tokens = Math.max(Number(seen.max_input_tokens ?? 0), Number(row.model_info?.max_input_tokens ?? 0)) || null;
        seen.supports_vision = seen.supports_vision || row.model_info?.supports_vision === true;
        groups.set(row.model_name, seen);
      }
      return send(200, { data: [...groups.values()] });
    }

    if (route === "POST /model/new") {
      // The flag gates the DEPLOYMENT half and not the credential half. Measured, and it is the
      // worst possible shape: green checkmarks on changes that never took.
      if (!storeModelInDb) return send(500, { error: { message: DB_OFF, type: "auth_error" } });
      const id = String(body?.model_info?.id ?? randomUUID());
      // A DUPLICATE ID ANSWERS 500, IT DOES NOT UPSERT. Measured. So a caller that retries a
      // timed-out add without looking first makes a mess it cannot see.
      if (deployments.some((row) => row.model_info.id === id)) {
        return send(500, { error: { message: "Failed to add model to db" } });
      }
      deployments.push({
        model_name: String(body?.model_name ?? ""),
        litellm_params: { ...(body?.litellm_params ?? {}) },
        model_info: { ...(body?.model_info ?? {}), id, db_model: true },
      });
      return send(200, { model_id: id, model_name: String(body?.model_name ?? "") });
    }

    if (route === "POST /model/update") {
      if (!storeModelInDb) return send(500, { error: { message: DB_OFF, type: "auth_error" } });
      // MEASURED: a model_info-only body answers 400. That is why the label edit is a PATCH and why
      // the two are not one function in cp/proxy.mjs.
      if (body?.litellm_params === undefined) return send(400, { error: { message: "litellm_params not provided" } });
      const id = String(body?.model_info?.id ?? "");
      const row = deployments.find((one) => one.model_info.id === id);
      if (row == null) return send(404, { error: { message: `no model with id ${id}` } });
      // IT MERGES. It changed litellm_params.model and left litellm_credential_name and every tb_
      // key exactly as they were, which is what makes "a vendor retired a model" one call.
      row.litellm_params = { ...row.litellm_params, ...(body.litellm_params ?? {}) };
      row.model_info = { ...row.model_info, ...(body.model_info ?? {}), id };
      if (body?.model_name) row.model_name = String(body.model_name);
      return send(200, { model_id: id });
    }

    if (request.method === "PATCH" && /^\/model\/[^/]+\/update$/.test(url.pathname)) {
      if (!storeModelInDb) return send(500, { error: { message: DB_OFF, type: "auth_error" } });
      const id = decodeURIComponent(url.pathname.split("/")[2]);
      const row = deployments.find((one) => one.model_info.id === id);
      if (row == null) return send(404, { error: { message: `no model with id ${id}` } });
      row.model_info = { ...row.model_info, ...(body?.model_info ?? {}), id };
      if (body?.litellm_params) row.litellm_params = { ...row.litellm_params, ...body.litellm_params };
      return send(200, { model_id: id });
    }

    if (route === "POST /model/delete") {
      if (!storeModelInDb) return send(500, { error: { message: DB_OFF, type: "auth_error" } });
      const id = String(body?.id ?? "");
      const at = deployments.findIndex((row) => row.model_info.id === id);
      if (at === -1) return send(404, { error: { message: `no model with id ${id}` } });
      deployments.splice(at, 1);
      return send(200, { deleted: id });
    }

    // ---- credentials ---------------------------------------------------------------------------

    if (route === "GET /credentials") {
      // MASKED ON READ, by the proxy itself. The panel renders this mask and never one it computed.
      return send(200, {
        credentials: [...credentials.values()].map((row) => ({
          credential_name: row.credential_name,
          credential_values: { ...row.credential_values, api_key: maskOf(row.credential_values.api_key) },
          credential_info: { ...row.credential_info },
        })),
      });
    }

    if (route === "POST /credentials") {
      const name = String(body?.credential_name ?? "");
      if (name.length === 0) return send(422, { error: { message: "credential_name is required" } });
      if (credentials.has(name)) return send(400, { error: { message: `credential ${name} already exists` } });
      credentials.set(name, {
        credential_name: name,
        credential_values: { ...(body?.credential_values ?? {}) },
        credential_info: { ...(body?.credential_info ?? {}) },
      });
      return send(200, { credential_name: name });
    }

    if (request.method === "PATCH" && /^\/credentials\/[^/]+$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[2]);
      // MEASURED: 422 without credential_name IN THE BODY as well as in the path. The merged design
      // did not have that, and a client that sent only the path got a refusal it could not read.
      if (String(body?.credential_name ?? "").length === 0) {
        return send(422, { detail: [{ loc: ["body", "credential_name"], msg: "field required" }] });
      }
      const row = credentials.get(name);
      if (row == null) return send(404, { error: { message: `no credential named ${name}` } });
      row.credential_values = { ...row.credential_values, ...(body?.credential_values ?? {}) };
      if (body?.credential_info) row.credential_info = { ...body.credential_info };
      return send(200, { credential_name: name });
    }

    if (request.method === "DELETE" && /^\/credentials\/[^/]+$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[2]);
      if (!credentials.has(name)) return send(404, { error: { message: `no credential named ${name}` } });
      credentials.delete(name);
      return send(200, { deleted: name });
    }

    if (request.method === "GET" && /^\/credentials\/by_name\/[^/]+$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[3]);
      const row = credentials.get(name);
      if (row == null) return send(404, { error: { message: `no credential named ${name}` } });
      return send(200, {
        credential_name: row.credential_name,
        credential_values: { ...row.credential_values, api_key: maskOf(row.credential_values.api_key) },
        credential_info: { ...row.credential_info },
      });
    }

    // ---- the fallback map ----------------------------------------------------------------------
    //
    // Three sharp edges, all measured. GET with no model is a 405, so there is no list-all. POST
    // takes {model, fallback_models} and VALIDATES that the target exists. DELETE needs
    // fallback_type in the query or it answers 404 while GET on the same alias answers 200.

    if (route === "GET /fallback") return send(405, { detail: "Method Not Allowed" });

    if (request.method === "GET" && /^\/fallback\/[^/]+$/.test(url.pathname)) {
      const alias = decodeURIComponent(url.pathname.split("/")[2]);
      const rows = fallbacks.get(alias);
      if (rows == null) return send(404, { error: { message: `no fallback set for ${alias}` } });
      return send(200, { model: alias, fallback_models: rows });
    }

    if (route === "POST /fallback") {
      const alias = String(body?.model ?? "");
      const wanted = Array.isArray(body?.fallback_models) ? body.fallback_models.map(String) : [];
      const missing = wanted.filter((one) => !deployments.some((row) => row.model_name === one));
      if (missing.length > 0) {
        return send(400, { error: { message: `Invalid fallback models: ${JSON.stringify(missing)}. Available: ${JSON.stringify([...new Set(deployments.map((row) => row.model_name))])}` } });
      }
      // POST on an alias that already has one OVERWRITES it, which is what makes a repoint one call.
      fallbacks.set(alias, wanted);
      return send(200, { model: alias, fallback_models: wanted });
    }

    if (request.method === "DELETE" && /^\/fallback\/[^/]+$/.test(url.pathname)) {
      const alias = decodeURIComponent(url.pathname.split("/")[2]);
      if (String(url.searchParams.get("fallback_type") ?? "").length === 0) {
        return send(404, { detail: "Not Found" });
      }
      fallbacks.delete(alias);
      return send(200, { deleted: alias });
    }

    // ---- pass-through endpoints ------------------------------------------------------------------

    if (route === "GET /config/pass_through_endpoint") {
      // HEADERS IN THE CLEAR, unlike /credentials, which masks. Measured. cp/proxy.mjs drops them
      // before anything above it can put one on a screen, and this stub answers with them so that
      // drop is measured rather than assumed.
      return send(200, { endpoints: [...passThrough.values()] });
    }

    if (route === "POST /config/pass_through_endpoint") {
      const id = randomUUID();
      passThrough.set(id, {
        id,
        path: String(body?.path ?? ""),
        target: String(body?.target ?? ""),
        headers: { ...(body?.headers ?? {}) },
        include_subpath: body?.include_subpath === true,
        cost_per_request: body?.cost_per_request ?? null,
        is_from_config: false,
      });
      return send(200, { path: String(body?.path ?? "") });
    }

    if (route === "DELETE /config/pass_through_endpoint") {
      // BY ITS UUID, not its path. Deleting by path answers 400 and leaves the row serving, which
      // is a removal that would read as a missing feature to anyone who did not look.
      const id = String(url.searchParams.get("endpoint_id") ?? "");
      if (!passThrough.has(id)) {
        return send(400, { error: { message: `endpoint_id ${id} was not found in pass-through endpoint list` } });
      }
      passThrough.delete(id);
      return send(200, { deleted: id });
    }

    // ---- health --------------------------------------------------------------------------------

    if (route === "GET /health") {
      const id = String(url.searchParams.get("model_id") ?? "");
      const row = deployments.find((one) => one.model_info.id === id);
      if (row == null) return send(400, { error: { message: `no model with id ${id}` } });
      const sick = healthLatest.get(id);
      if (sick != null && String(sick.status) !== "healthy") {
        return send(503, { healthy_endpoints: [], unhealthy_endpoints: [{ model: row.model_name, error: sick.error_message }] });
      }
      return send(200, { healthy_endpoints: [{ model: row.model_name }], unhealthy_endpoints: [] });
    }

    if (route === "GET /health/latest") {
      return send(200, { latest_health_checks: Object.fromEntries(healthLatest) });
    }

    // ---- keys ------------------------------------------------------------------------------------

    if (route === "POST /key/generate") {
      minted += 1;
      const value = `sk-tenant-${minted}-${Math.random().toString(36).slice(2, 10)}`;
      const record = {
        key: value,
        keyId: `hashed-${minted}`,
        alias: String(body?.key_alias ?? ""),
        tags: Array.isArray(body?.tags) ? body.tags : [],
        models: Array.isArray(body?.models) ? body.models.map(String) : [],
        allowedRoutes: Array.isArray(body?.allowed_routes) ? body.allowed_routes.map(String) : [],
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
      // THE PROXY-8 BACKFILL'S BRANCH POINT. Measured on this Mac 2026-09-08: /key/update takes
      // allowed_routes and it takes on the SAME KEY VALUE, so the sweep over every key already in
      // the field writes nothing into a box. Had it not, the backfill would have been a fleet-wide
      // rotate and would not have happened in this wave at all.
      if (Array.isArray(body?.allowed_routes)) record.allowedRoutes = body.allowed_routes.map(String);
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

    if (route === "GET /v1/models" || route === "GET /models") {
      return send(200, { data: [...new Set(deployments.map((row) => row.model_name))].map((id) => ({ id })) });
    }

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
    /** The database, for assertions that would otherwise go through the thing being tested. */
    deployments: () => deployments.map((row) => ({ ...row, model_info: { ...row.model_info } })),
    credentials: () => [...credentials.values()].map((row) => ({ ...row })),
    fallbacks: () => Object.fromEntries(fallbacks),
    passThrough: () => [...passThrough.values()].map((row) => ({ ...row })),
    /**
     * A pass-through planted directly, so a test can start from the state the R750 was really in.
     *
     * MEASURED THERE 2026-09-08: /catalog/zai and /catalog/minimax were both live with a cleartext
     * `authorization` header in LiteLLM_Config, and the minimax one had never served a read. An
     * install that already carries those has to lose them, and that can only be tested from a
     * starting state the panel itself will no longer create.
     */
    addPassThroughRow({ path: pathname, target, headers = {}, includeSubpath = true }) {
      const id = randomUUID();
      passThrough.set(id, { id, path: String(pathname), target: String(target), headers: { ...headers }, include_subpath: includeSubpath === true, cost_per_request: null, is_from_config: false });
      return id;
    },
    /** The flag, which is what makes the half-state testable rather than a story. */
    setStoreModelInDb: (on) => { storeModelInDb = on !== false; },
    /** One deployment marked sick, so the panel's health column has something true to show. */
    setHealth(id, status, error = "") {
      healthLatest.set(String(id), { model_name: deployments.find((row) => row.model_info.id === id)?.model_name ?? "", status, error_message: error, checked_at: nowIso() });
    },
    setCatalog(provider, names) { catalogs[provider] = [...names]; },
    /** The sha256 of what is really in a slot, so a roll can be proved without printing a key. */
    credentialDigest(name) {
      const row = credentials.get(name);
      return row == null ? "" : createHash("sha256").update(String(row.credential_values.api_key), "utf8").digest("hex");
    },
    /**
     * Spend put on a key without a request, for the panel assertions.
     *
     * `recordedModel` is what the LOG says, which on a real install is the VENDOR model and not the
     * alias: on the R750 2026-09-08 `select model,count(*) from "LiteLLM_SpendLogs"` answered
     * openai/glm-5.3 596 times and the alias plan-zai three times in the whole log. The panel used
     * to decide which workspaces ran an alias by matching that string, so it believed plan-zai was
     * run by one workspace while three were on it -- and that list is what the remove guard reads.
     * `status` is the outcome of the request, which is the only evidence this install has that a
     * provider is unwell.
     */
    chargeAlias(alias, dollars, requests = 1, model = "plan-zai", { recordedModel = "", status = "success" } = {}) {
      const record = keys.get(byAlias.get(alias));
      if (record == null) return false;
      record.spend += dollars;
      record.requests += requests;
      const perModel = record.perModel.get(model) ?? { requests: 0, dollars: 0 };
      perModel.requests += requests;
      perModel.dollars += dollars;
      record.perModel.set(model, perModel);
      const behind = deployments.find((row) => row.model_name === model);
      for (let i = 0; i < requests; i += 1) {
        logs.push({
          api_key: record.keyId, key_alias: record.alias, spend: dollars / requests,
          model: recordedModel || model, startTime: nowIso(), status,
          model_id: behind?.model_info?.id ?? "", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
          ...(status === "failure" ? { metadata: { error_information: { error_message: "the vendor refused this request" } } } : {}),
        });
      }
      return true;
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
