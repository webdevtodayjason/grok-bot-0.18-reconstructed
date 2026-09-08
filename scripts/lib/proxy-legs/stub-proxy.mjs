// A stand-in for the proxy, speaking the surface our own code talks to (PROXY-1).
//
// WHY THIS EXISTS. The real image is a gigabyte. A gate that pulls it does not fit in the 300
// seconds every gate on this project is held to, so it would be run once and then skipped, which is
// the same as not having one. This stub answers the LiteLLM routes the control plane, the relay and
// the box actually call, in a few milliseconds, so `node scripts/verify-proxy.mjs` proves OUR code
// on every commit. `--real` is the opt-in path that runs the same legs against the pulled image.
//
// WHAT IT IS AND IS NOT. It is a faithful copy of the SHAPE: the same paths, the same status codes,
// the same error bodies, the same header. It is not a copy of LiteLLM's behaviour, and a leg that
// would only be proving this file's own arithmetic says so where it is written. Two things it does
// model on purpose, because our design depends on them and nothing else would catch them going
// wrong: the two-key pool draining to its second entry when one upstream fails, and a virtual key
// stopping working within the cache TTL after it is revoked.
//
// It reads the REAL deploy/coolify/proxy-config/config.yaml, with a small reader for the two shapes
// that file uses. That is deliberate: it means a change to the model names in that file changes what
// this stub serves, and the service leg's assertions are about the file an operator ships rather
// than about a copy of it in a test.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

// ---- reading the model list ------------------------------------------------------------------------
// Not a YAML parser. config.yaml's model_list is a flat list of two-level entries and every value in
// it is a plain scalar; anything else in there would be a change worth noticing rather than a change
// to parse. A commented-out entry is not a model, which is exactly the point: plan-qwen is written
// out in that file and left off until a key for it exists, and this reader must agree.
export function readModelList(text) {
  const models = [];
  let inList = false;
  let current = null;
  for (const raw of String(text).split("\n")) {
    if (/^model_list:\s*$/.test(raw)) { inList = true; continue; }
    if (!inList) continue;
    if (/^\S/.test(raw) && raw.trim() !== "") break;          // the next top-level key ends the list
    const line = raw.replace(/\s+$/, "");
    if (/^\s*#/.test(line) || line.trim() === "") continue;    // a commented entry is not a model
    const name = /^ {2}- model_name:\s*(\S+)\s*$/.exec(line);
    if (name) {
      current = { model_name: name[1], model: "", api_base: "", api_key_env: "" };
      models.push(current);
      continue;
    }
    if (!current) continue;
    const model = /^ {6}model:\s*(\S+)\s*$/.exec(line);
    if (model) { current.model = model[1]; continue; }
    const base = /^ {6}api_base:\s*(\S+)\s*$/.exec(line);
    if (base) { current.api_base = base[1]; continue; }
    const key = /^ {6}api_key:\s*os\.environ\/([A-Z0-9_]+)\s*$/.exec(line);
    if (key) { current.api_key_env = key[1]; continue; }
  }
  return models;
}

// The general_settings numbers the design pinned, read back out of the same file so a leg can assert
// the file says what the design decided rather than asserting a constant in a test.
export function readGeneralSettings(text) {
  const settings = {};
  let inBlock = false;
  for (const raw of String(text).split("\n")) {
    if (/^general_settings:\s*$/.test(raw)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^\S/.test(raw) && raw.trim() !== "") break;
    const match = /^ {2}([a-z_]+):\s*(\S+)\s*$/.exec(raw.replace(/\s+$/, ""));
    if (!match) continue;
    settings[match[1]] = /^\d+$/.test(match[2]) ? Number(match[2]) : match[2] === "true" ? true : match[2] === "false" ? false : match[2];
  }
  return settings;
}

// Which TOP-LEVEL key a block is nested under, by its own name.
//
// This exists because of one measured failure. MEASURED ON THE R750 2026-09-08:
// `pass_through_endpoints` sat at the top level of config.yaml, LiteLLM reads it only from
// general_settings, and the proxy started clean, logged nothing and answered 404 on every
// /tinyfish path -- while docs/PROXY.md carried a measured table for the route. A block in the
// wrong place is silence, so the gate reads where each one actually is.
export function blockParentOf(text, blockName) {
  let parent = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const top = /^([a-z_]+):\s*$/.exec(line);
    if (top) { parent = top[1]; if (top[1] === blockName) return "(top level)"; continue; }
    if (new RegExp(`^\\s{2}${blockName}:\\s*$`).test(line)) return parent;
  }
  return null;
}

// The values of a simple `  key:` list nested one level under general_settings, in order.
export function readNestedList(text, blockName) {
  const values = [];
  let inBlock = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (new RegExp(`^\\s{2}${blockName}:\\s*$`).test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    const item = /^ {4}- (\S+)\s*$/.exec(line);
    if (item) { values.push(item[1]); continue; }
    break;
  }
  return values;
}

// The same list as deploy/coolify/proxy-config/config.yaml's general_settings.allowed_routes.
// Kept as a literal rather than read out of the YAML: the gate has to FAIL when the two drift, and
// reading the file would make them agree by construction.
const ALLOWED_ROUTES = new Set([
  "/v1/chat/completions", "/chat/completions", "/v1/models", "/models",
  "/tinyfish/fetch", "/tinyfish/search", "/mcp", "/mcp/",
  "/key/generate", "/key/info", "/key/update", "/key/delete",
  "/model/info", "/spend/logs", "/health/readiness", "/health/liveness",
]);

const json = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

// LiteLLM's own error envelope, which is what our code has to read to turn a budget stop into the
// customer's four sentences. Keeping the shape here is the point of the stub.
const errorBody = (message, type, code) => ({ error: { message, type, param: null, code: String(code) } });

/**
 * Start the stub.
 *
 * @param {object} options
 * @param {string} options.configPath   the config.yaml to serve, normally the real one in deploy/
 * @param {string} options.masterKey    what the operator authenticates with
 * @param {Record<string,string>} options.upstreams  api_key env name -> a base url to call, so a leg
 *                                      can take one "subscription" down and watch the pool drain
 * @param {number} options.cacheTtlMs   how long a revoked key keeps working, modelling
 *                                      user_api_key_cache_ttl
 */
export function createStubProxy({ configPath, masterKey, upstreams = {}, cacheTtlMs = 0 } = {}) {
  const state = {
    keys: new Map(),          // key -> record
    revokedAt: new Map(),     // key -> ms, so the cache ttl is modelled rather than instant
    spend: new Map(),         // key -> dollars
    requests: [],             // {key, model, upstream, at}
    upstreamFailures: new Map(),
    calls: [],
  };

  let config = readFileSync(configPath, "utf8");
  let models = readModelList(config);
  // Re-read from disk. The design binds a DIRECTORY rather than the file, so that an operator can
  // change the model list without the container being recreated; this is the stub's version of that,
  // and the service leg uses it to prove the shape end to end.
  const reload = () => {
    config = readFileSync(configPath, "utf8");
    models = readModelList(config);
    return models;
  };

  const modelNames = () => [...new Set(models.map((one) => one.model_name))];

  const authorise = (request) => {
    const header = String(request.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return { kind: "none" };
    if (token === masterKey) return { kind: "master", token };
    const record = state.keys.get(token);
    if (!record) return { kind: "unknown", token };
    const revoked = state.revokedAt.get(token);
    // Revoked, but still inside the authorisation cache window: LiteLLM answers from its cache, so
    // "revocation is immediate" is a claim no honest gate can make. This is what makes the leg
    // measure the seconds instead.
    if (revoked !== undefined && Date.now() - revoked >= cacheTtlMs) return { kind: "revoked", token };
    return { kind: "key", token, record };
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url, "http://stub");
      const route = `${request.method} ${url.pathname}`;
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      state.calls.push({ route, at: Date.now() });

      // The door list, applied BEFORE the credential is looked at, which is where the real proxy
      // applies it (pre_db_read_auth_checks in litellm/proxy/auth/auth_utils.py). It is one global
      // list, so it refuses the master key too, and it is what closes GET /health -- a route a
      // tenant's own virtual key could call, which makes a live call to every provider deployment
      // on the operator's subscriptions. MEASURED ON THE R750 2026-09-08 before the list existed:
      // one sweep of /health put three rows in /spend/logs under `litellm-internal-health-check`,
      // charged to the operator and attributed to no tenant.
      if (!ALLOWED_ROUTES.has(url.pathname) && !url.pathname.startsWith("/tinyfish/") && !url.pathname.startsWith("/mcp")) {
        return json(response, 403, errorBody(`Access forbidden: Route ${url.pathname} not allowed`, "auth_error", 403));
      }

      // Readiness needs no credential, the same as the real one: it is what a deploy and a health
      // check ask, and a health route behind a key is a health route nobody can use.
      if (route === "GET /health/readiness") {
        return json(response, 200, { status: "connected", db: "connected", litellm_version: "stub" });
      }

      const who = authorise(request);
      if (who.kind === "none") {
        return json(response, 401, errorBody("Authentication Error, No api key passed in.", "auth_error", 401));
      }
      if (who.kind === "unknown" || who.kind === "revoked") {
        return json(response, 401, errorBody("Authentication Error, Invalid proxy server token passed.", "auth_error", 401));
      }

      // ---- the operator's routes -------------------------------------------------------------------
      if (route.endsWith("/key/generate") || route.endsWith("/key/delete") || route.endsWith("/key/update")
        || url.pathname.startsWith("/global/spend")) {
        if (who.kind !== "master") {
          return json(response, 401, errorBody("Authentication Error, Only the master key may call this route.", "auth_error", 401));
        }
      }

      if (route === "POST /key/generate") {
        const key = `sk-${randomBytes(16).toString("hex")}`;
        const record = {
          key,
          key_alias: body?.key_alias ?? null,
          tags: body?.tags ?? [],
          models: Array.isArray(body?.models) ? body.models : [],
          metadata: body?.metadata ?? {},
          rpm_limit: body?.rpm_limit ?? null,
          soft_budget: body?.soft_budget ?? null,
          max_budget: body?.max_budget ?? null,
          created_at: new Date().toISOString(),
        };
        if (record.key_alias && [...state.keys.values()].some((one) => one.key_alias === record.key_alias)) {
          return json(response, 400, errorBody(`Unable to create key: key_alias ${record.key_alias} already exists`, "budget_exceeded", 400));
        }
        state.keys.set(key, record);
        state.spend.set(key, 0);
        return json(response, 200, { key, key_alias: record.key_alias, models: record.models, expires: null });
      }

      if (route === "GET /key/info") {
        const asked = url.searchParams.get("key") ?? (who.kind === "key" ? who.token : "");
        const record = state.keys.get(asked);
        if (!record) return json(response, 404, errorBody("Key not found", "not_found", 404));
        // A key may read its own info and nothing else's.
        //
        // THIS IS STRICTER THAN THE PROXY WE RUN, and saying so here is the point. MEASURED ON THE
        // R750 2026-09-08: v1.100.0 answers 200 to any virtual key that passes another tenant's
        // key HASH to /key/info, alias, models, spend and budget included. The door list cannot
        // close it, because cp/admin.mjs calls /key/info itself and the list is global. That is
        // PROXY-8. The stub keeps the behaviour the product wants so this leg measures OUR side;
        // the real gap is a named row and not a silent difference.
        if (who.kind === "key" && asked !== who.token) {
          return json(response, 401, errorBody("Authentication Error, a key may only read its own info.", "auth_error", 401));
        }
        return json(response, 200, {
          key: asked,
          info: {
            key_alias: record.key_alias,
            models: record.models,
            spend: state.spend.get(asked) ?? 0,
            soft_budget: record.soft_budget,
            max_budget: record.max_budget,
            rpm_limit: record.rpm_limit,
            metadata: record.metadata,
            tags: record.tags,
          },
        });
      }

      if (route === "POST /key/delete") {
        const byKey = Array.isArray(body?.keys) ? body.keys : [];
        const byAlias = Array.isArray(body?.key_aliases) ? body.key_aliases : [];
        const deleted = [];
        for (const [key, record] of state.keys) {
          if (byKey.includes(key) || (record.key_alias && byAlias.includes(record.key_alias))) {
            state.revokedAt.set(key, Date.now());
            deleted.push(record.key_alias ?? key);
          }
        }
        return json(response, 200, { deleted_keys: deleted });
      }

      if (route === "POST /key/update") {
        const record = state.keys.get(body?.key ?? "");
        if (!record) return json(response, 404, errorBody("Key not found", "not_found", 404));
        for (const field of ["max_budget", "soft_budget", "rpm_limit", "models"]) {
          if (body[field] !== undefined) record[field] = body[field];
        }
        return json(response, 200, { key: record.key, ...record });
      }

      // Spend, grouped the way the admin console's panel reads it. The design chose the virtual key
      // as the one handle: not tags (tag budgets are an enterprise feature), not the end-user header
      // (a box calls directly and we cannot force it), and never the caller address (every box is on
      // one bridge, and TENANCY 19.3 holds a box address untrusted).
      if (url.pathname === "/global/spend/report") {
        const rows = [...state.spend].map(([key, spend]) => ({
          api_key: key,
          key_alias: state.keys.get(key)?.key_alias ?? null,
          spend,
          total_requests: state.requests.filter((one) => one.key === key).length,
        }));
        return json(response, 200, rows);
      }

      if (url.pathname === "/spend/logs") {
        const asked = url.searchParams.get("api_key");
        const rows = state.requests
          .filter((one) => (who.kind === "master" ? true : one.key === who.token))
          .filter((one) => (asked ? one.key === asked : true))
          .map((one) => ({ api_key: one.key, model: one.model, spend: one.spend, startTime: new Date(one.at).toISOString() }));
        return json(response, 200, rows);
      }

      // ---- the customer's routes -------------------------------------------------------------------
      if (route === "GET /v1/models" || route === "GET /models") {
        reload();
        const allowed = who.kind === "master" || who.record.models.length === 0
          ? modelNames()
          : modelNames().filter((name) => who.record.models.includes(name));
        return json(response, 200, { object: "list", data: allowed.map((id) => ({ id, object: "model", owned_by: "titanbot" })) });
      }

      if (route === "POST /v1/chat/completions" || route === "POST /chat/completions") {
        reload();
        const wanted = String(body?.model ?? "");
        const entries = models.filter((one) => one.model_name === wanted);
        if (entries.length === 0) {
          return json(response, 400, errorBody(`Invalid model name passed in model=${wanted}`, "invalid_request_error", 400));
        }
        if (who.kind === "key" && who.record.models.length > 0 && !who.record.models.includes(wanted)) {
          return json(response, 401, errorBody(`Authentication Error, key not allowed to access model=${wanted}`, "auth_error", 401));
        }

        if (who.kind === "key") {
          const record = who.record;
          // The rate limit, as the customer's second sentence sees it.
          if (record.rpm_limit != null) {
            const recent = state.requests.filter((one) => one.key === who.token && Date.now() - one.at < 60_000);
            if (recent.length >= record.rpm_limit) {
              return json(response, 429, errorBody(
                `Max parallel request limit reached. Hit limit for api_key: ${who.token.slice(0, 8)}...`, "rate_limit_error", 429));
            }
          }
          // And the budget stop, which is a 400 with this exact type. Enforced only when max_budget
          // is set: soft_budget is the observe-mode shape and by LiteLLM's definition never fails a
          // request, it only produces the number the 80 percent chip reads.
          const spent = state.spend.get(who.token) ?? 0;
          if (record.max_budget != null && spent >= record.max_budget) {
            return json(response, 400, errorBody(
              `ExceededBudget: Crossed spend within budget. Current cost: ${spent}, Max budget: ${record.max_budget}`,
              "budget_exceeded", 400));
          }
        }

        // The pool. simple-shuffle over the entries sharing this model_name, with a failed upstream
        // retried on the other one, which is the whole reason two subscriptions are held.
        const order = [...entries].sort(() => Math.random() - 0.5);
        let lastError = "no deployment was tried";
        for (const entry of order) {
          const upstream = upstreams[entry.api_key_env];
          if (!upstream) { lastError = `no upstream for ${entry.api_key_env}`; continue; }
          const answer = await fetch(`${upstream}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: entry.model, messages: body?.messages ?? [] }),
            signal: AbortSignal.timeout(5_000),
          }).catch((error) => ({ ok: false, status: 0, _error: String(error?.message ?? error) }));
          if (!answer.ok) {
            state.upstreamFailures.set(entry.api_key_env, (state.upstreamFailures.get(entry.api_key_env) ?? 0) + 1);
            lastError = `${entry.api_key_env} answered ${answer.status ?? 0}`;
            continue;
          }
          const payload = await answer.json();
          const cost = 0.01;
          if (who.kind === "key") {
            state.spend.set(who.token, (state.spend.get(who.token) ?? 0) + cost);
            state.requests.push({ key: who.token, model: wanted, upstream: entry.api_key_env, spend: cost, at: Date.now() });
          }
          return json(response, 200, {
            id: `chatcmpl-${randomBytes(8).toString("hex")}`,
            object: "chat.completion",
            model: wanted,
            // Which pooled entry answered, so a leg can watch the pool drain. The real proxy carries
            // this in a header; here it is in the body because that is what the leg can read.
            served_by: entry.api_key_env,
            choices: [{ index: 0, message: { role: "assistant", content: payload.content ?? "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          });
        }
        // Every entry failed. The customer's third sentence comes from this.
        return json(response, 500, errorBody(
          `litellm.APIConnectionError: no deployment of ${wanted} answered (${lastError})`, "api_error", 500));
      }

      // The TinyFish passthrough, which is metered per request rather than per token.
      if (url.pathname.startsWith("/tinyfish/")) {
        const target = upstreams.TINYFISH;
        if (!target) return json(response, 502, errorBody("no tinyfish upstream is configured", "api_error", 502));
        const answer = await fetch(`${target}${url.pathname.replace("/tinyfish", "")}`, {
          method: request.method,
          headers: { "content-type": "application/json" },
          body: body === null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (!answer || !answer.ok) return json(response, 502, errorBody("the tinyfish upstream did not answer", "api_error", 502));
        const payload = await answer.json();
        if (who.kind === "key") {
          const cost = 0.0001;
          state.spend.set(who.token, (state.spend.get(who.token) ?? 0) + cost);
          state.requests.push({ key: who.token, model: url.pathname, upstream: "TINYFISH", spend: cost, at: Date.now() });
        }
        return json(response, 200, payload);
      }

      return json(response, 404, errorBody(`the stub proxy has no ${route}`, "not_found", 404));
    });
  });

  return {
    server,
    state,
    reload,
    modelNames: () => modelNames(),
    generalSettings: () => readGeneralSettings(config),
    allowedRoutes: () => [...ALLOWED_ROUTES],
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * A stand-in provider, so a leg can hold one "subscription" down and watch the pool drain to the
 * other. `healthy` is a plain flag the leg flips.
 */
export function createStubUpstream({ name, content = "an answer" } = {}) {
  const state = { healthy: true, calls: 0, name };
  const server = createServer((request, response) => {
    state.calls += 1;
    if (!state.healthy) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: `${name} is down`, type: "api_error" } }));
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content, provider: name }));
    });
  });
  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
