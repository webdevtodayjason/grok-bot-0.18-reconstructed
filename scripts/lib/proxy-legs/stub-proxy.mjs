// A stand-in for the proxy, speaking the surface our own code talks to (PROXY-1, PROVIDERS-1).
//
// WHY THIS EXISTS. The real image is a gigabyte. A gate that pulls it does not fit in the 300
// seconds every gate on this project is held to, so it would be run once and then skipped, which is
// the same as not having one. This stub answers the LiteLLM routes the control plane, the relay, the
// admin console and the box actually call, in a few milliseconds, so `node scripts/verify-proxy.mjs`
// proves OUR code on every commit. `--real` is the opt-in path that runs the same legs against the
// pulled image.
//
// WHAT IT IS AND IS NOT. It is a faithful copy of the SHAPE: the same paths, the same status codes,
// the same error bodies, the same header. It is not a copy of LiteLLM's behaviour, and a leg that
// would only be proving this file's own arithmetic says so where it is written.
//
// ---- THE SHARP EDGES ARE THE POINT, AND EVERY ONE OF THEM IS MEASURED ---------------------------
// The management surface below was written against a real docker.litellm.ai/berriai/litellm-database
// :v1.100.0 on this Mac on 2026-09-08, one worker, postgres:16 beside it. Copying only the happy
// paths would make a stub that agrees with code that cannot work in production, so the refusals are
// copied too:
//
//   POST /model/new with a model_info.id that already exists   500, never an upsert. So the control
//                                                             plane generates and tracks ids.
//   POST /model/update with no litellm_params                  400 "litellm_params not provided"
//   POST /model/update WITH them                               MERGES: the credential reference, the
//                                                             costs and every tb_* key survive
//   PATCH /model/{id}/update with model_info alone             200, merges. This is the label edit
//                                                             and the park toggle, and it is a
//                                                             path-parameter route, which is one
//                                                             reason an exact-match door list could
//                                                             not be the boundary any more
//   POST /model/delete on a config-declared model              400 "not found in db", by model_name
//                                                             AND by its hashed model_info.id
//   PATCH /credentials/{name} with no credential_name in the   422 field required. The name is in the
//     BODY                                                    path AND in the body or it is refused
//   GET /credentials, GET /credentials/by_name/{n}             api_key masked to sk****AA on read
//   POST /fallback {"fallbacks":[{...}]}                       422; the shape is {model,
//                                                             fallback_models}
//   POST /fallback naming a model the proxy does not serve     400 "Invalid fallback models" with the
//                                                             available list. The vision deployment
//                                                             exists before its pair is registered
//   POST /fallback for a pair router_settings already declares 200 "updated successfully" -- NOT
//                                                             refused, which is what lets stage one
//                                                             seed the map before stage two drops it
//   POST /fallback of a model onto itself                      400 "cannot be its own fallback"
//   GET /fallback                                              405; the read is GET /fallback/{model}
//   GET /config/pass_through_endpoint                          headers UNMASKED, and for an entry
//                                                             declared in config.yaml the os.environ
//                                                             reference comes back RESOLVED. The
//                                                             panel must never render these
//   POST /config/pass_through_endpoint                         serves on the next request with no
//                                                             restart, but only with include_subpath
//                                                             true does a subpath route at all
//   a virtual key with allowed_routes set                      403 "Virtual key is not allowed to
//                                                             call this route. Only allowed to call
//                                                             routes: [...]. Tried to call route: X"
//   a default-minted virtual key                               200 on /key/info and /model/info --
//                                                             which IS PROXY-8, and is why the
//                                                             per-key list exists
//   a default-minted virtual key on /model/new, /credentials   403 role=internal_user, 401 "Only
//                                                             proxy admin can be used to ..."
//   /spend/logs                                                one row per request_id, and the
//                                                             upstream's completion id IS the
//                                                             request_id. An upstream that reuses one
//                                                             collapses every request onto a single
//                                                             row: measured, 12 requests became 1
//                                                             row until the upstream returned unique
//                                                             ids, at which point model_id and
//                                                             model_group were populated per row
//
// /model/block and /model/unblock are NOT implemented here and are called nowhere. On v1.100.0 they
// return 500 while still changing state, so a caller that reads 500 as failure would show the
// operator the opposite of the truth. Parking a deployment is PATCH /model/{id}/update with
// model_info {blocked: true}, which is what this serves.
//
// It reads the REAL deploy/coolify/proxy-config/config.yaml, with a small reader for the shapes that
// file uses. That is deliberate: a change to the file changes what this stub serves, and the service
// leg's assertions are about the file an operator ships rather than about a copy of it in a test.
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// ---- reading the model list ------------------------------------------------------------------------
// Not a YAML parser. A model_list is a flat list of two-level entries and every value in it is a
// plain scalar; anything else in there would be a change worth noticing rather than a change to
// parse. A commented-out entry is not a model, which is exactly the point.
//
// As of PROVIDERS-1 the SHIPPED config.yaml has no model_list at all -- the deployments live in the
// proxy's database -- so this returns an empty array for it, and config.stage1.yaml beside it is the
// one that still has entries. Both are correct answers and the caller decides which file to ask.
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

// ---- the routes a tenant key is scoped to --------------------------------------------------------
// The per-key door list that REPLACED general_settings.allowed_routes. It is deliberately a literal
// here rather than read out of bootstrap.json: the gate has to FAIL when the two drift, and reading
// the file would make them agree by construction. There is no global list any more -- the
// hard-coded ALLOWED_ROUTES set that used to sit here was deleted in the same commit that deleted
// the list from config.yaml, so the stub and the product cannot drift in opposite directions.
export const TENANT_ALLOWED_ROUTES = [
  "/v1/chat/completions", "/chat/completions", "/v1/models", "/models",
];

const json = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

// LiteLLM's own error envelope, which is what our code has to read to turn a budget stop into the
// customer's four sentences. Keeping the shape here is the point of the stub.
const errorBody = (message, type, code) => ({ error: { message, type, param: null, code: String(code) } });

// FastAPI's validation envelope, which is a DIFFERENT shape from LiteLLM's own and is what a caller
// that got a body field wrong actually sees.
const validationBody = (field, input) => ({
  detail: [{ type: "missing", loc: ["body", field], msg: "Field required", input }],
});

// What /credentials and only /credentials does to a value on the way out.
const maskKey = (value) => {
  const text = String(value ?? "");
  if (text.length <= 6) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
};

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
 * @param {Record<string,string>} options.environment  what os.environ/<NAME> resolves to, so a
 *                                      pass-through can be proved to carry a reference rather than a
 *                                      value
 */
export function createStubProxy({ configPath, masterKey, upstreams = {}, cacheTtlMs = 0, environment = {} } = {}) {
  const state = {
    keys: new Map(),          // key -> record
    revokedAt: new Map(),     // key -> ms, so the cache ttl is modelled rather than instant
    spend: new Map(),         // key -> dollars
    requests: [],             // one per request, which is what a spend row is
    upstreamFailures: new Map(),
    calls: [],
    // ---- the database-backed half (PROVIDERS-1) ------------------------------------------------
    credentials: new Map(),   // credential_name -> {credential_values, credential_info}
    deployments: new Map(),   // model_info.id -> {model_name, litellm_params, model_info}
    fallbacks: new Map(),     // model_name -> [fallback model_name]
    // A LIST, not a map keyed by path, because the real one APPENDS. MEASURED on this Mac
    // 2026-09-08 against v1.100.0: registering a path that already exists adds a SECOND row
    // rather than replacing the first, the FIRST one keeps serving, and the duplicates pile up
    // in LiteLLM_Config.general_settings forever. A map would have made the stub forgiving of
    // exactly the mistake that makes a panel report a change it did not make.
    passThroughs: [],  // [{id, path, target, headers, include_subpath, cost_per_request, is_from_config}]
    healthChecks: new Map(),  // model_name -> the row GET /health/latest serves
    workers: 1,               // what GET /health/readiness reports, so a leg can assert it
  };

  let config = readFileSync(configPath, "utf8");
  let fileModels = readModelList(config);
  // Re-read from disk. The design binds a DIRECTORY rather than the file, so an operator can change
  // what is in it without the container being recreated; this is the stub's version of that.
  const reload = () => {
    config = readFileSync(configPath, "utf8");
    fileModels = readModelList(config);
    return fileModels;
  };

  // The file's deployments and the database's, together, exactly as /model/info reports them during
  // the window between the seed and restart two. A model_name can carry both.
  const allDeployments = () => [
    ...fileModels.map((one) => ({
      model_name: one.model_name,
      litellm_params: { model: one.model, api_base: one.api_base, api_key_env: one.api_key_env },
      // A config-declared row's id is a hash LiteLLM makes up, and /model/delete refuses it.
      model_info: { id: createHash("sha256").update(`${one.model_name}:${one.model}:${one.api_key_env}`).digest("hex"), db_model: false },
      _fromFile: true,
    })),
    ...[...state.deployments.values()].map((one) => ({ ...one, _fromFile: false })),
  ];

  const modelNames = () => [...new Set(allDeployments().map((one) => one.model_name))];

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

  // What os.environ/<NAME> resolves to when this stub forwards a pass-through header. A name nothing
  // sets forwards the LITERAL STRING, which is what the real one does, and is why the reserved
  // TinyFish pair is commented out in config.yaml rather than shipped empty.
  const resolveHeader = (value) => {
    const ref = /^(.*)os\.environ\/([A-Z0-9_]+)$/.exec(String(value ?? ""));
    if (!ref) return String(value ?? "");
    const resolved = environment[ref[2]];
    return resolved === undefined ? String(value) : `${ref[1]}${resolved}`;
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

      // Readiness needs no credential, the same as the real one: it is what a deploy and a health
      // check ask, and a health route behind a key is a health route nobody can use.
      if (route === "GET /health/readiness") {
        return json(response, 200, {
          status: "connected", db: "connected", litellm_version: "stub",
          // Not a field the real one carries under this name; the providers leg reads the worker
          // count from the compose when it is real and from here when it is not, and says which.
          num_workers: state.workers,
        });
      }

      const who = authorise(request);
      if (who.kind === "none") {
        return json(response, 401, errorBody("Authentication Error, No api key passed in.", "auth_error", 401));
      }
      if (who.kind === "unknown" || who.kind === "revoked") {
        return json(response, 401, errorBody("Authentication Error, Invalid proxy server token passed.", "auth_error", 401));
      }

      // ---- THE PER-KEY DOOR LIST, which is what replaced the global one --------------------------
      // MEASURED on this Mac 2026-09-08: a virtual key minted with allowed_routes answers 403 with
      // exactly this sentence on any route not on its own list, while the master key is unaffected.
      // That is what closes PROXY-8 (a tenant reading another tenant's /key/info) and closes /health
      // to a tenant at the same time, which was the global list's real job.
      if (who.kind === "key" && Array.isArray(who.record.allowed_routes) && who.record.allowed_routes.length > 0
        && !who.record.allowed_routes.includes(url.pathname)) {
        const list = who.record.allowed_routes.map((one) => `'${one}'`).join(", ");
        return json(response, 403, {
          detail: `Virtual key is not allowed to call this route. Only allowed to call routes: [${list}]. `
            + `Tried to call route: ${url.pathname}`,
        });
      }

      // ---- the operator's routes -------------------------------------------------------------------
      // The role check under the per-key list, which needs no configuration at all. Two different
      // refusals, both measured, because our code reads the status and the sentence.
      const MODEL_MANAGEMENT = ["/model/new", "/model/update", "/model/delete"];
      if (MODEL_MANAGEMENT.includes(url.pathname) || url.pathname.startsWith("/model/") && request.method === "PATCH") {
        if (who.kind !== "master") {
          return json(response, 403, errorBody(
            "{'error': 'User does not have permission to make this model call. Your role=internal_user. "
            + "You can only make model calls if you are a PROXY_ADMIN or if you are a team admin, by specifying a team_id in model_info'}",
            "auth_error", 403));
        }
      }
      if (url.pathname.startsWith("/credentials") || url.pathname.startsWith("/config/pass_through_endpoint")
        || url.pathname.startsWith("/fallback")) {
        if (who.kind !== "master") {
          return json(response, 401, errorBody(
            `Authentication Error, Only proxy admin can be used to generate, delete, update info for new keys/users/teams. `
            + `Route=${url.pathname}. Your role=unknown. Your user_id=*******`, "auth_error", 401));
        }
      }
      if (route.endsWith("/key/generate") || route.endsWith("/key/delete") || route.endsWith("/key/update")
        || url.pathname.startsWith("/global/spend")) {
        if (who.kind !== "master") {
          return json(response, 401, errorBody("Authentication Error, Only the master key may call this route.", "auth_error", 401));
        }
      }

      if (route === "POST /key/generate") {
        // MEASURED on this Mac 2026-09-08 against v1.100.0, and it is the reason nothing in this
        // product tags a key: a mint carrying `tags` is refused outright on the open build. The
        // tenant is carried in key_alias and metadata instead, which is where the panel reads it
        // from anyway. A stub that accepted tags let a gate pass here and fail against the image.
        if (Array.isArray(body?.tags) && body.tags.length > 0) {
          return json(response, 403, errorBody(
            "{'error': 'This feature is only available for LiteLLM Enterprise users: tags. "
            + "You must be a LiteLLM Enterprise user to use this feature.'}", "auth_error", 403));
        }
        const key = `sk-${randomBytes(16).toString("hex")}`;
        const record = {
          key,
          key_alias: body?.key_alias ?? null,
          tags: body?.tags ?? [],
          models: Array.isArray(body?.models) ? body.models : [],
          // Minted with the per-key list from the start, as of PROVIDERS-1. An EMPTY list is
          // unrestricted, which is what every key already in the field carries and what the backfill
          // is for.
          allowed_routes: Array.isArray(body?.allowed_routes) ? body.allowed_routes : [],
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
        return json(response, 200, {
          key, key_alias: record.key_alias, models: record.models,
          allowed_routes: record.allowed_routes, expires: null,
        });
      }

      if (route === "GET /key/info") {
        const asked = url.searchParams.get("key") ?? (who.kind === "key" ? who.token : "");
        const record = state.keys.get(asked);
        if (!record) return json(response, 404, errorBody("Key not found", "not_found", 404));
        // PROXY-8, kept HONEST rather than kept safe.
        //
        // MEASURED on this Mac 2026-09-08 and again on the R750: v1.100.0 answers 200 to any virtual
        // key that passes another key's hash here, alias, models, spend and budget included. This
        // stub used to refuse that, which made the gate prove a boundary the product did not have.
        // It no longer does. What closes it is the key's OWN allowed_routes list, checked above, and
        // the providers leg measures exactly that: a scoped key gets 403 here, an unscoped one gets
        // 200, and the difference is the fix.
        return json(response, 200, {
          key: asked,
          info: {
            key_alias: record.key_alias,
            models: record.models,
            allowed_routes: record.allowed_routes,
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
        // allowed_routes is on this list because the PROXY-8 backfill depends on it. MEASURED on
        // this Mac 2026-09-08: POST /key/update accepts allowed_routes on a key that already exists,
        // answers 200 with the list echoed back, and the key is refused the closed routes on its next
        // request -- so every key already in the field is closed by a sweep that writes NOTHING into
        // a box. Had that not been true, the backfill would have had to be a rotate, and a rotate
        // writes a new key into a box.
        for (const field of ["max_budget", "soft_budget", "rpm_limit", "models", "allowed_routes"]) {
          if (body[field] !== undefined) record[field] = body[field];
        }
        return json(response, 200, { key: record.key, ...record });
      }

      // ---- credentials: a provider key, and the pool it belongs to --------------------------------
      if (url.pathname === "/credentials" && request.method === "GET") {
        return json(response, 200, {
          success: true,
          credentials: [...state.credentials.entries()].map(([credential_name, one]) => ({
            credential_name,
            credential_values: { api_key: maskKey(one.api_key) },
            credential_info: one.credential_info,
          })),
        });
      }

      if (url.pathname.startsWith("/credentials/by_name/") && request.method === "GET") {
        const name = decodeURIComponent(url.pathname.slice("/credentials/by_name/".length));
        const one = state.credentials.get(name);
        if (!one) return json(response, 404, { detail: { error: `Credential not found: ${name}` } });
        return json(response, 200, {
          credential_name: name,
          credential_info: one.credential_info,
          credential_values: { api_key: maskKey(one.api_key) },
        });
      }

      if (url.pathname === "/credentials" && request.method === "POST") {
        const name = body?.credential_name;
        if (!name) return json(response, 422, validationBody("credential_name", body));
        if (state.credentials.has(name)) {
          return json(response, 400, errorBody(`Credential ${name} already exists`, "auth_error", 400));
        }
        state.credentials.set(name, {
          api_key: String(body?.credential_values?.api_key ?? ""),
          credential_info: body?.credential_info ?? {},
        });
        return json(response, 200, { success: true, message: "Credential created successfully" });
      }

      if (url.pathname.startsWith("/credentials/") && request.method === "PATCH") {
        const name = decodeURIComponent(url.pathname.slice("/credentials/".length));
        // The name is in the path AND in the body. MEASURED: without it, 422 field required. That is
        // worth copying, because the roll is the one operation this whole wave is judged on and a
        // 422 there is a key that did not change while the panel said it did.
        if (!body?.credential_name) return json(response, 422, validationBody("credential_name", body));
        const existing = state.credentials.get(name);
        if (!existing) return json(response, 404, { detail: { error: `Credential not found: ${name}` } });
        if (body?.credential_values?.api_key !== undefined) existing.api_key = String(body.credential_values.api_key);
        if (body?.credential_info !== undefined) existing.credential_info = body.credential_info;
        return json(response, 200, { success: true, message: "Credential updated successfully" });
      }

      if (url.pathname.startsWith("/credentials/") && request.method === "DELETE") {
        const name = decodeURIComponent(url.pathname.slice("/credentials/".length));
        if (!state.credentials.has(name)) return json(response, 404, { detail: { error: `Credential not found: ${name}` } });
        state.credentials.delete(name);
        return json(response, 200, { success: true, message: "Credential deleted successfully" });
      }

      // ---- deployments: a plan model, and the keys behind it --------------------------------------
      if (route === "POST /model/new") {
        const id = body?.model_info?.id ?? randomUUID();
        // NEVER an upsert. MEASURED: a duplicate id answers 500 "Failed to add model to db", which is
        // why the control plane generates the id and keeps track of it rather than posting twice and
        // hoping.
        if (state.deployments.has(id)) {
          return json(response, 500, errorBody("{'error': 'Failed to add model to db. Check your server logs for more details.'}", "auth_error", 500));
        }
        if (!body?.model_name || !body?.litellm_params) {
          return json(response, 422, validationBody(body?.model_name ? "litellm_params" : "model_name", body));
        }
        const record = {
          model_name: body.model_name,
          litellm_params: { ...body.litellm_params },
          model_info: { ...(body.model_info ?? {}), id, db_model: true, blocked: false },
        };
        state.deployments.set(id, record);
        return json(response, 200, { model_id: id, model_name: record.model_name, litellm_params: record.litellm_params });
      }

      if (route === "POST /model/update") {
        // MEASURED: 400, with LiteLLM's own auth_error envelope rather than FastAPI's, which is the
        // kind of thing a caller's error handling gets wrong once.
        if (!body?.litellm_params) {
          return json(response, 400, errorBody("Authentication Error, litellm_params not provided", "auth_error", 400));
        }
        const id = body?.model_info?.id;
        const record = state.deployments.get(id);
        if (!record) return json(response, 400, errorBody(`{'error': 'Model with id=${id} not found in db'}`, "auth_error", 400));
        // MERGE, not replace. MEASURED: after a /model/update carrying only `model`, the credential
        // reference and the costs were still there and every tb_* key had survived. That is what
        // makes repointing an alias at a new vendor model one call instead of a read-modify-write.
        record.litellm_params = { ...record.litellm_params, ...body.litellm_params };
        record.model_info = { ...record.model_info, ...(body.model_info ?? {}), id, db_model: true };
        return json(response, 200, { model_id: id, model_name: record.model_name, litellm_params: record.litellm_params });
      }

      if (request.method === "PATCH" && /^\/model\/[^/]+\/update$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[2]);
        const record = state.deployments.get(id);
        if (!record) return json(response, 400, errorBody(`{'error': 'Model with id=${id} not found in db'}`, "auth_error", 400));
        // model_info ALONE is accepted here and merged, which /model/update refuses. This is the
        // label edit and the park toggle, and it is a path-parameter route -- one of the two reasons
        // an exact-match global door list could not be the boundary any more.
        if (body?.litellm_params) record.litellm_params = { ...record.litellm_params, ...body.litellm_params };
        if (body?.model_info) record.model_info = { ...record.model_info, ...body.model_info, id, db_model: true };
        return json(response, 200, { model_id: id, model_name: record.model_name, litellm_params: record.litellm_params, model_info: record.model_info });
      }

      if (route === "POST /model/delete") {
        const id = body?.id;
        if (!state.deployments.has(id)) {
          // Including a model declared in config.yaml, by name OR by the hashed id /model/info gives
          // it. MEASURED both ways. A panel that offered a Delete on a config row would be offering
          // an action that cannot work.
          return json(response, 400, errorBody(`{'error': 'Model with id=${id} not found in db'}`, "auth_error", 400));
        }
        state.deployments.delete(id);
        return json(response, 200, { message: `Model id=${id} deleted successfully` });
      }

      if (route === "GET /model/info") {
        reload();
        const asked = url.searchParams.get("litellm_model_id");
        let rows = allDeployments();
        // A tenant key sees only what it is scoped to, which is how the customer's own Settings list
        // is built without the control plane in the way.
        if (who.kind === "key" && who.record.models.length > 0) {
          rows = rows.filter((one) => who.record.models.includes(one.model_name));
        }
        if (asked) rows = rows.filter((one) => one.model_info.id === asked);
        return json(response, 200, {
          data: rows.map((one) => ({
            model_name: one.model_name,
            litellm_params: one.litellm_params,
            model_info: one.model_info,
          })),
        });
      }

      if (route === "GET /model_group/info") {
        reload();
        const groups = new Map();
        for (const one of allDeployments()) {
          if (who.kind === "key" && who.record.models.length > 0 && !who.record.models.includes(one.model_name)) continue;
          const existing = groups.get(one.model_name) ?? {
            model_group: one.model_name,
            providers: [],
            max_input_tokens: null,
            supports_vision: false,
            // Where the customer-facing words come from, carried on model_info by us and round-tripped
            // by LiteLLM intact. MEASURED: model_info accepts arbitrary keys and gives them all back.
            tb_customer_name: null,
            tb_customer_label: null,
            tb_customer_visible: false,
            tb_served_by: null,
            tb_provider: null,
            tb_vision_fallback: null,
            tb_plans: [],
            deployments: 0,
          };
          existing.deployments += 1;
          existing.max_input_tokens = one.model_info.max_input_tokens ?? existing.max_input_tokens;
          existing.supports_vision = Boolean(one.model_info.supports_vision) || existing.supports_vision;
          for (const field of ["tb_customer_name", "tb_customer_label", "tb_served_by", "tb_provider", "tb_vision_fallback"]) {
            if (one.model_info[field] !== undefined) existing[field] = one.model_info[field];
          }
          if (one.model_info.tb_customer_visible !== undefined) existing.tb_customer_visible = Boolean(one.model_info.tb_customer_visible);
          if (Array.isArray(one.model_info.tb_plans)) existing.tb_plans = one.model_info.tb_plans;
          groups.set(one.model_name, existing);
        }
        return json(response, 200, { data: [...groups.values()] });
      }

      // ---- the fallback map ------------------------------------------------------------------------
      if (url.pathname === "/fallback" && request.method === "GET") {
        // MEASURED: 405. The read is GET /fallback/{model_name}. A caller that expects a whole map
        // from one call gets a Method Not Allowed and nothing else.
        return json(response, 405, { detail: "Method Not Allowed" });
      }

      if (url.pathname === "/fallback" && request.method === "POST") {
        if (!body?.model) return json(response, 422, validationBody("model", body));
        if (!Array.isArray(body?.fallback_models)) return json(response, 422, validationBody("fallback_models", body));
        const available = modelNames();
        if (body.fallback_models.includes(body.model)) {
          return json(response, 400, { detail: { error: `Model '${body.model}' cannot be its own fallback` } });
        }
        const unknown = body.fallback_models.filter((one) => !available.includes(one));
        if (unknown.length > 0) {
          // MEASURED. This is why `proxy seed` writes deployments FIRST and the map second: a vision
          // model that does not exist yet cannot be named as a fallback.
          return json(response, 400, { detail: { error: `Invalid fallback models: ${JSON.stringify(unknown)}`, available_models: available } });
        }
        // A pair router_settings.fallbacks already declares is NOT refused: it answers 200 and the
        // database takes it over. That is what makes stage one able to seed the map before stage two
        // stops the file declaring it.
        state.fallbacks.set(body.model, [...body.fallback_models]);
        return json(response, 200, {
          model: body.model, fallback_models: body.fallback_models,
          fallback_type: "general", message: "Fallback configuration updated successfully",
        });
      }

      if (url.pathname.startsWith("/fallback/")) {
        const name = decodeURIComponent(url.pathname.slice("/fallback/".length));
        const declared = state.fallbacks.get(name) ?? fileFallbackFor(config, name);
        if (!declared) return json(response, 404, { detail: { error: `No general fallbacks configured for model '${name}'` } });
        if (request.method === "DELETE") {
          state.fallbacks.delete(name);
          return json(response, 200, { message: `Fallback configuration for '${name}' deleted successfully` });
        }
        return json(response, 200, { model: name, fallback_models: declared, fallback_type: "general" });
      }

      // ---- pass-through endpoints -------------------------------------------------------------------
      if (url.pathname === "/config/pass_through_endpoint" && request.method === "GET") {
        // HEADERS UNMASKED, and for a config-declared entry the os.environ reference comes back
        // RESOLVED -- the operator's real key in a response body. /credentials masks; this does not.
        // The panel must never render these, and tests/cp-server.test.mjs asserts it does not.
        return json(response, 200, {
          endpoints: state.passThroughs.map((one) => ({
            id: one.id,
            path: one.path,
            target: one.target,
            headers: one.is_from_config
              ? Object.fromEntries(Object.entries(one.headers).map(([k, v]) => [k, resolveHeader(v)]))
              : one.headers,
            default_query_params: {},
            include_subpath: Boolean(one.include_subpath),
            cost_per_request: one.cost_per_request ?? null,
            timeout: null,
            auth: true,
            guardrails: null,
            is_from_config: Boolean(one.is_from_config),
            methods: null,
          })),
        });
      }

      if (url.pathname === "/config/pass_through_endpoint" && request.method === "POST") {
        if (!body?.path || !body?.target) return json(response, 422, validationBody(body?.path ? "target" : "path", body));
        const record = {
          id: randomUUID(),
          path: body.path,
          target: body.target,
          headers: body.headers ?? {},
          include_subpath: Boolean(body.include_subpath),
          cost_per_request: body.cost_per_request ?? null,
          is_from_config: false,
        };
        // APPEND. Registering a path that already exists does not replace it: the old row keeps
        // serving and both rows are stored. So repointing a catalog path is delete-by-id THEN
        // register, and a panel that just re-registers reports a change that did not happen.
        state.passThroughs.push(record);
        return json(response, 200, { endpoints: [{ ...record }] });
      }

      if (url.pathname === "/config/pass_through_endpoint" && request.method === "DELETE") {
        // BY ROW ID, never by path. MEASURED on this Mac 2026-09-08 against v1.100.0:
        //   DELETE ?endpoint_id=/qa/deletable                     400
        //   DELETE ?endpoint_id=6fc7fd6e-cd9b-4889-b0bc-3749f...  200, and the route then 404s
        // The id is the uuid the POST answered with. A caller that passes the path gets a 400 and,
        // if it does not check, leaves the endpoint serving while believing it removed it -- which
        // is how the gate's own cleanup used to leave rows behind on a real proxy.
        const wanted = url.searchParams.get("endpoint_id") ?? "";
        const at = state.passThroughs.findIndex((one) => one.id === wanted);
        if (at === -1) {
          return json(response, 400, errorBody(`endpoint ${wanted} not found`, "auth_error", 400));
        }
        const [gone] = state.passThroughs.splice(at, 1);
        return json(response, 200, { endpoints: [{ ...gone }] });
      }

      // ---- health, on demand and read back --------------------------------------------------------
      if (url.pathname === "/health") {
        reload();
        const asked = url.searchParams.get("model");
        const rows = allDeployments().filter((one) => (asked ? one.model_name === asked : true));
        const healthy = [];
        const unhealthy = [];
        for (const one of rows) {
          const env = one.litellm_params.api_key_env
            ?? state.credentials.get(one.litellm_params.litellm_credential_name)?.credential_info?.env;
          const up = env ? Boolean(upstreams[env]) : true;
          (up ? healthy : unhealthy).push({ ...one.litellm_params, model_id: one.model_info.id });
        }
        for (const name of new Set(rows.map((one) => one.model_name))) {
          state.healthChecks.set(name, {
            health_check_id: randomUUID(),
            model_name: name,
            model_id: null,
            status: unhealthy.length === 0 ? "healthy" : "unhealthy",
            healthy_count: healthy.length,
            unhealthy_count: unhealthy.length,
            error_message: null,
            response_time_ms: 4.7,
            checked_by: "default_user_id",
            checked_at: new Date().toISOString(),
          });
        }
        return json(response, 200, {
          healthy_endpoints: healthy, unhealthy_endpoints: unhealthy,
          healthy_count: healthy.length, unhealthy_count: unhealthy.length,
        });
      }

      if (url.pathname === "/health/latest") {
        return json(response, 200, { latest_health_checks: Object.fromEntries(state.healthChecks) });
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
        // ONE ROW PER request_id, which is the upstream's completion id. MEASURED on this Mac
        // 2026-09-08: an upstream returning a constant id collapsed twelve requests onto ONE row,
        // and the same twelve with unique ids produced twelve rows carrying model_id and
        // model_group. A customer whose provider reuses ids would read as near zero spend, so the
        // providers leg asserts the row count equals the request count rather than that rows exist.
        const byRequestId = new Map();
        for (const one of state.requests) {
          if (who.kind !== "master" && one.key !== who.token) continue;
          if (asked && one.key !== asked) continue;
          byRequestId.set(one.request_id, {
            request_id: one.request_id,
            api_key: one.key,
            model: one.vendor_model,
            model_id: one.model_id,
            model_group: one.model,
            status: one.status,
            spend: one.spend,
            total_tokens: one.total_tokens,
            startTime: new Date(one.at).toISOString(),
          });
        }
        return json(response, 200, [...byRequestId.values()]);
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
        const entries = allDeployments().filter((one) => one.model_name === wanted);
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

        // The pool. simple-shuffle over every deployment sharing this model_name -- the file's and
        // the database's alike, which is exactly what the window between the seed and restart two
        // looks like -- with a failed upstream retried on the next one.
        const order = [...entries].sort(() => Math.random() - 0.5);
        let lastError = "no deployment was tried";
        for (const entry of order) {
          const env = entry.litellm_params.api_key_env
            ?? state.credentials.get(entry.litellm_params.litellm_credential_name)?.credential_info?.env;
          const upstream = upstreams[env];
          if (!upstream) { lastError = `no upstream for ${env ?? "an unnamed credential"}`; continue; }
          const answer = await fetch(`${upstream}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: entry.litellm_params.model, messages: body?.messages ?? [] }),
            signal: AbortSignal.timeout(5_000),
          }).catch((error) => ({ ok: false, status: 0, _error: String(error?.message ?? error) }));
          if (!answer.ok) {
            state.upstreamFailures.set(env, (state.upstreamFailures.get(env) ?? 0) + 1);
            lastError = `${env} answered ${answer.status ?? 0}`;
            continue;
          }
          const payload = await answer.json();
          const cost = 0.01;
          // The completion id IS the spend row's request_id, which is why a stub upstream that
          // returns a constant one collapses a run. This takes the upstream's if it gave one.
          const requestId = payload.id ?? `chatcmpl-${randomUUID()}`;
          state.requests.push({
            key: who.kind === "key" ? who.token : "master",
            model: wanted,
            vendor_model: entry.litellm_params.model,
            model_id: entry.model_info.id,
            request_id: requestId,
            upstream: env,
            spend: cost,
            total_tokens: 12,
            status: "success",
            at: Date.now(),
          });
          if (who.kind === "key") state.spend.set(who.token, (state.spend.get(who.token) ?? 0) + cost);
          return json(response, 200, {
            id: requestId,
            object: "chat.completion",
            model: wanted,
            // Which pooled entry answered, so a leg can watch the pool drain and watch a rolled key
            // take over. The real proxy carries this in a header; here it is in the body because that
            // is what the leg can read. served_by_key is the credential NAME, never its value.
            served_by: env,
            served_by_key: entry.litellm_params.litellm_credential_name ?? null,
            served_by_model_id: entry.model_info.id,
            served_by_value: payload.content ?? null,
            choices: [{ index: 0, message: { role: "assistant", content: payload.content ?? "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          });
        }
        // Every entry failed. The customer's third sentence comes from this, and a failure row is
        // written, because disable_error_logs is deliberately NOT set: a run in which nothing could
        // ever be recorded as a failure cannot prove there were none.
        state.requests.push({
          key: who.kind === "key" ? who.token : "master",
          model: wanted, vendor_model: wanted, model_id: "",
          request_id: `chatcmpl-${randomUUID()}`, upstream: null, spend: 0, total_tokens: 0,
          status: "failure", at: Date.now(),
        });
        return json(response, 500, errorBody(
          `litellm.APIConnectionError: no deployment of ${wanted} answered (${lastError})`, "api_error", 500));
      }

      // The TinyFish passthrough and any catalog path registered live, both metered per request
      // rather than per token. A registered path serves its SUBPATH only when include_subpath is
      // true, which is measured and is the difference between a working Refresh button and a 404.
      // FIRST match wins, in registration order, which is what makes a duplicate registration
      // keep serving the older target.
      const record = state.passThroughs.find((one) =>
        url.pathname === one.path || (one.include_subpath && url.pathname.startsWith(`${one.path}/`)));
      if (record) {
        const path = record.path;
        // A stub NEVER calls the internet. The file's own entries point at api.fetch.tinyfish.ai and
        // friends; unless a leg has supplied a loopback stand-in for that target, this answers the
        // way a proxy with no reachable upstream would, WITHOUT making the call. The leg that cares
        // about the route existing checks for "not a 404", which this still is.
        const target = upstreams[record.target] ?? upstreams[path] ?? record.target;
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(target))) {
          return json(response, 502, errorBody(
            `the stub proxy has no stand-in upstream for ${record.target}, so it did not call it`, "api_error", 502));
        }
        const suffix = url.pathname.slice(path.length);
        const answer = await fetch(`${target}${suffix}${url.search}`, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(record.headers).map(([k, v]) => [k, resolveHeader(v)])),
          body: body === null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (!answer || !answer.ok) return json(response, 502, errorBody("the upstream did not answer", "api_error", 502));
        const payload = await answer.json();
        if (who.kind === "key") {
          const cost = record.cost_per_request ?? 0.0001;
          state.spend.set(who.token, (state.spend.get(who.token) ?? 0) + cost);
          state.requests.push({
            key: who.token, model: url.pathname, vendor_model: url.pathname, model_id: "",
            request_id: `passthrough-${randomUUID()}`, upstream: "passthrough", spend: cost,
            total_tokens: 0, status: "success", at: Date.now(),
          });
        }
        return json(response, 200, payload);
      }

      return json(response, 404, errorBody(`the stub proxy has no ${route}`, "not_found", 404));
    });
  });

  // The fallback pairs config.yaml itself declares, so GET /fallback/{name} answers for one the
  // database has never been told about. config.stage1.yaml has one; the shipped config.yaml has none,
  // which is the whole point of the second restart.
  function fileFallbackFor(text, name) {
    let inBlock = false;
    for (const raw of String(text).split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      if (/^\s{2}fallbacks:\s*$/.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      const pair = /^\s{4}- ([a-z0-9-]+):\s*\[(.*)\]\s*$/.exec(line);
      if (!pair) break;
      if (pair[1] !== name) continue;
      return pair[2].split(",").map((one) => one.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    return null;
  }

  // Register the file's own pass-through entries, so a leg can ask the SERVER whether the route
  // exists rather than trusting the file -- a block in the wrong place has to fail a gate.
  const seedPassThroughsFromFile = () => {
    let inBlock = false;
    let current = null;
    let inHeaders = false;
    for (const raw of String(config).split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      if (/^\s{2}pass_through_endpoints:\s*$/.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      if (/^\s{0,2}\S/.test(line) && !/^\s{4}/.test(line)) break;
      const path = /^\s{4}- path:\s*(\S+)\s*$/.exec(line);
      if (path) {
        current = { id: randomUUID(), path: path[1], target: "", headers: {}, include_subpath: false, cost_per_request: null, is_from_config: true };
        state.passThroughs.push(current);
        inHeaders = false;
        continue;
      }
      if (!current) continue;
      const target = /^\s{6}target:\s*(\S+)\s*$/.exec(line);
      if (target) { current.target = target[1]; inHeaders = false; continue; }
      if (/^\s{6}headers:\s*$/.test(line)) { inHeaders = true; continue; }
      const cost = /^\s{6}cost_per_request:\s*(\S+)\s*$/.exec(line);
      if (cost) { current.cost_per_request = Number(cost[1]); inHeaders = false; continue; }
      const header = /^\s{8}([a-z0-9-]+):\s*(\S+)\s*$/.exec(line);
      if (header && inHeaders) { current.headers[header[1]] = header[2]; continue; }
    }
  };
  seedPassThroughsFromFile();

  return {
    server,
    state,
    reload,
    modelNames: () => modelNames(),
    generalSettings: () => readGeneralSettings(config),
    // No allowedRoutes() any more: there is no global list. The per-key one is on each key record and
    // TENANT_ALLOWED_ROUTES above is what a key is minted with.
    tenantAllowedRoutes: () => [...TENANT_ALLOWED_ROUTES],
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * A stand-in provider, so a leg can hold one "subscription" down and watch the pool drain to the
 * other. `healthy` is a plain flag the leg flips, and `content` is what it answers, so a leg can see
 * WHICH key served a request after a roll.
 *
 * Its completion id is unique per response, deliberately. MEASURED on this Mac 2026-09-08 against
 * the real image: an upstream returning a constant id made LiteLLM upsert twelve requests onto ONE
 * spend row. That is a real hazard for a real vendor, and a stub that hid it would let a spend gate
 * pass on a product that shows a busy customer as near zero.
 */
export function createStubUpstream({ name, content = "an answer" } = {}) {
  // sawKeys is how a key ROLL is proved against a real proxy. A roll does not move traffic to a
  // different upstream -- the deployment's api_base never changes -- it changes the credential the
  // SAME upstream is called with. So the only place the new value is visible is here.
  const state = { healthy: true, calls: 0, name, content, sawKeys: [] };
  const server = createServer((request, response) => {
    state.calls += 1;
    state.sawKeys.push(String(request.headers.authorization ?? request.headers["x-api-key"] ?? ""));
    if (!state.healthy) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: `${name} is down`, type: "api_error" } }));
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      // A REAL chat completion body, because --real points a real LiteLLM at this server and it
      // parses what comes back. `content` and `provider` stay at the top level as well: the stub
      // proxy reads those, and a leg tells the subscriptions apart by the sentence each one says.
      response.end(JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: state.name,
        choices: [{ index: 0, message: { role: "assistant", content: state.content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        content: state.content,
        provider: name,
      }));
    });
  });
  return {
    state,
    // host is the name the CALLER can reach this server by. 127.0.0.1 for an in-process stub;
    // host.docker.internal (or whatever TITANBOT_PROXY_UPSTREAM_HOST says) when a real proxy in a
    // container has to call back. It always BINDS on 0.0.0.0 in that case, or the container's
    // request arrives at an interface nothing is listening on.
    async listen({ host } = {}) {
      const bind = host && host !== "127.0.0.1" ? "0.0.0.0" : "127.0.0.1";
      await new Promise((resolve) => server.listen(0, bind, resolve));
      return `http://${host ?? "127.0.0.1"}:${server.address().port}`;
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * A stand-in VENDOR CATALOG, which is what a Refresh button reads through a pass-through. It answers
 * the shape a vendor's /models really answers and nothing more: MEASURED on grok-bot-local-vm
 * 2026-09-08 against Z.AI, ten ids carrying id, object, created and owned_by -- no context window,
 * no vision flag, no label. It records the key it was called with, so a leg can prove the control
 * plane read a live catalog while holding no vendor key.
 */
export function createStubCatalog({ name = "vendor", models = ["one", "two", "three"] } = {}) {
  const state = { calls: 0, sawKeys: [], name };
  const server = createServer((request, response) => {
    state.calls += 1;
    state.sawKeys.push(String(request.headers.authorization ?? request.headers["x-api-key"] ?? ""));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: models.map((id) => ({ id, object: "model", created: 1, owned_by: name })),
    }));
  });
  return {
    state,
    async listen({ host } = {}) {
      const bind = host && host !== "127.0.0.1" ? "0.0.0.0" : "127.0.0.1";
      await new Promise((resolve) => server.listen(0, bind, resolve));
      return `http://${host ?? "127.0.0.1"}:${server.address().port}`;
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
