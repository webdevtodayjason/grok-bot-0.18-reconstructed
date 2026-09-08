// cp/proxy.mjs -- the control plane's side of the proxy (PROXY-1).
//
// THE WORD. LiteLLM is THE PROXY. It runs as the Coolify service titanbot-proxy on titanbot-net,
// it answers on http://titanbot-proxy:4000 inside the bridge and nowhere else, and it is the only
// thing in this product called a proxy. "Gateway" keeps its existing meaning everywhere in this
// tree: a box's own host gateway on port 1340, behind TITANBOT_GATEWAY_TOKEN. The two words are
// not interchangeable and a reader who mixes them up will point a box at the wrong thing.
//
// What this file is for. Until now every box carried a copy of the operator's own provider key.
// Measured on the R750 on 2026-09-08, all three boxes held a byte identical box-secrets.json with
// one operator key in it, so a customer's agent and Jason's agent were spending the same
// subscription with no way to tell them apart and no way to cut one off. The proxy replaces that
// copy with one virtual key per box: metered, budgeted and revocable. This file is every call the
// control plane makes to it.
//
// Three rules this client keeps, and they are the reason it is hand written rather than an SDK:
//
//   1. It NEVER throws. Every function answers {ok: true, ...} or {ok: false, why: "..."}, the
//      same shape askRelay in cp/admin.mjs answers, because a proxy that is down has to come out
//      of the far end as a sentence a person reads and not as a stack trace on a customer's
//      screen.
//   2. Every call carries a deadline. CP_RELAY_TIMEOUT_MS is the one this service already has for
//      talking to something on the shared network, so it is the one used here too rather than a
//      second knob that will be set to a different number by accident.
//   3. Nothing in here writes a key anywhere. Reading and writing the per tenant file is
//      cp/provision.mjs's job, and it writes it 0600 in the tenant's own profile directory. This
//      file talks to the proxy and hands the answer back.
//
// No npm dependency, because cp/ has none on purpose: the image is node plus this directory, and
// the Dockerfile copies the directory rather than a list of files, so a new file here needs no
// build change.

// The three model names the proxy serves, frozen. They are a contract with every box pointed at
// the proxy: the box's box-secrets.json carries one of these strings as its MODEL, so renaming one
// silently breaks every customer already on it. Adding a fourth is a config change on the proxy
// plus a row here; renaming one of these three is not a thing that happens.
//
// The plan- prefix is load bearing twice. It is how the console tells an included row from a
// customer's own row, and it is how ensureProxyKey works out which of the models the proxy serves
// are ours to mint against.
export const PLAN_MODEL_PREFIX = "plan-";

// What a customer is told each one is, and what their agent says it runs on.
//
// `name` is the words on the card in Settings. `servedBy` is the sentence fragment the box puts in
// SAND_OPENAI_COMPATIBLE_SERVED_BY, which is what stops the persona note printing the host of the
// base url: without it a customer's own Titan would tell them it runs at titanbot-proxy, which is
// a container name, is meaningless to them, and is a fact about our infrastructure that they have
// no reason to be handed.
//
// contextWindow here is the FALLBACK. The measured number comes from the proxy's own /model/info,
// which reports max_input_tokens per model out of the model list it was configured with, and that
// is what gets written down when it answers. These numbers are what a card shows when it does not.
export const PLAN_MODELS = Object.freeze({
  "plan-zai": Object.freeze({
    name: "Z.AI GLM (included with your plan)",
    servedBy: "Z.AI GLM",
    contextWindow: 200_000,
  }),
  "plan-minimax": Object.freeze({
    name: "MiniMax M3 (included with your plan)",
    servedBy: "MiniMax M3",
    contextWindow: 200_000,
  }),
  "plan-qwen": Object.freeze({
    name: "Qwen (included with your plan)",
    servedBy: "Qwen",
    contextWindow: 128_000,
  }),
});

// The alias a tenant's key carries at the proxy. Derived from the slug rather than stored in a
// column, which is the whole reason this wave adds no schema change: /key/delete takes aliases, so
// the alias is the handle, and a handle you can compute is a handle that cannot go stale.
export const proxyKeyAlias = (slug) => `titanbot-${String(slug ?? "").trim()}`;

// The tag every key carries, which is what the spend report is grouped and filtered by.
export const proxyKeyTag = (slug) => `tenant:${String(slug ?? "").trim()}`;

// The one place that knows a key belongs to a plan model rather than to a customer's own provider.
export const isPlanModel = (id) => String(id ?? "").startsWith(PLAN_MODEL_PREFIX);

// A number out of an untyped JSON body, or null. Used everywhere below rather than Number(), which
// turns undefined into NaN and null into 0, and a zero on a spend panel is a lie that looks like a
// measurement.
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The first of several field names that carries a number. LiteLLM has renamed spend fields more
// than once across versions and the deployed one is pinned to a bare version, so reading a list of
// candidates is the difference between a panel that keeps working through an upgrade and one that
// silently reads zero.
function pick(row, names) {
  for (const name of names) {
    const value = numberOrNull(row?.[name]);
    if (value !== null) return value;
  }
  return null;
}

// YYYY-MM-DD in UTC, which is what /global/spend/report takes for start_date and end_date.
export const isoDay = (at) => new Date(at).toISOString().slice(0, 10);

// The first instant of this UTC month, as a day string. The panel says "this month" and this is
// what that means: calendar month, UTC, not a rolling thirty days, because a customer's allowance
// is a monthly allowance and a rolling window would never line up with it.
export function monthStartDay(at) {
  const date = new Date(at);
  return `${date.toISOString().slice(0, 7)}-01`;
}

/**
 * The client.
 *
 * `fetchImpl` is passed in so the tests and the gate can answer as the proxy does without a
 * network, exactly the way createCoolifyClient takes one.
 *
 * A client built with no url or no master key is not an error and does not throw. Every call on it
 * answers {ok: false, why} naming which setting is missing, because CP_PROXY_URL unset means the
 * feature is off on this server and every surface has to say so honestly rather than break.
 */
export function createProxyClient({ config = {}, fetchImpl = globalThis.fetch, timeoutMs = 0 } = {}) {
  const base = String(config.proxyUrl ?? "").replace(/\/+$/, "");
  const masterKey = String(config.proxyMasterKey ?? "");
  const deadline = Number(timeoutMs) > 0 ? Number(timeoutMs)
    : (Number(config.relayTimeoutMs) > 0 ? Number(config.relayTimeoutMs) : 15_000);

  const configured = base.length > 0 && masterKey.length > 0;
  const unconfigured = base.length === 0
    ? "this server has no proxy configured (CP_PROXY_URL is not set)"
    : "this server has a proxy address and no master key (CP_PROXY_MASTER_KEY is not set)";

  /** One request. Never throws. Never puts the master key anywhere but the Authorization header. */
  async function call(method, pathname, { body, query } = {}) {
    if (!configured) return { ok: false, why: unconfigured, configured: false };
    const search = query ? `?${new URLSearchParams(query).toString()}` : "";
    const init = {
      method,
      headers: { authorization: `Bearer ${masterKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(deadline),
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response;
    try { response = await fetchImpl(`${base}${pathname}${search}`, init); }
    catch (error) {
      const why = error?.name === "TimeoutError"
        ? `the proxy did not answer in time (${deadline} ms)`
        : `the proxy did not answer (${String(error?.message ?? error).split("\n")[0]})`;
      return { ok: false, why, configured: true };
    }
    let text = "";
    try { text = await response.text(); } catch { text = ""; }
    let parsed = null;
    if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    if (!response.ok) {
      // The proxy's own message, first line only and cut short. A LiteLLM error body can carry the
      // whole request back, and a request body on its way to a panel is how a key ends up on a
      // screen.
      const said = String(parsed?.error?.message ?? parsed?.detail?.error?.message ?? parsed?.detail ?? parsed?.message ?? "")
        .split("\n")[0].slice(0, 300);
      return {
        ok: false,
        status: response.status,
        why: `the proxy answered ${response.status}${said ? `: ${said}` : ""}`,
        configured: true,
      };
    }
    return { ok: true, status: response.status, body: parsed ?? {} };
  }

  return {
    base,
    configured,
    call,

    /**
     * One virtual key for one tenant.
     *
     * OBSERVE MODE IS THE DEFAULT AND IT IS NOT A HALF MEASURE. With CP_PROXY_ENFORCE unset the
     * key is minted with soft_budget, which by LiteLLM's own definition never fails a request but
     * does produce the number the 80 percent chip reads. Set CP_PROXY_ENFORCE and the same mint
     * sends max_budget, which does fail the request, and the box turns that into the plain
     * sentence about the plan being spent. Arming it is a separate decision from shipping this.
     */
    async mintKey({ slug, models = [], allowanceUsd = 0, enforce = false, rpmLimit = 0, box = "" }) {
      const alias = proxyKeyAlias(slug);
      const body = {
        key_alias: alias,
        tags: [proxyKeyTag(slug)],
        models: [...models],
        metadata: { slug: String(slug), box: String(box ?? "") },
      };
      if (Number(rpmLimit) > 0) body.rpm_limit = Number(rpmLimit);
      if (Number(allowanceUsd) > 0) {
        if (enforce) body.max_budget = Number(allowanceUsd);
        else body.soft_budget = Number(allowanceUsd);
      }
      const answer = await call("POST", "/key/generate", { body });
      if (!answer.ok) return answer;
      const key = String(answer.body?.key ?? "");
      if (key.length === 0) return { ok: false, why: "the proxy made a key and did not answer with it", configured: true };
      return {
        ok: true,
        key,
        // The hashed handle, under whichever name this build calls it. It is what the spend report
        // groups by, so a mint that cannot report one still works but leaves the panel joining on
        // the alias alone.
        keyId: String(answer.body?.token_id ?? answer.body?.token ?? answer.body?.key_name ?? ""),
        alias,
        enforced: Boolean(enforce && Number(allowanceUsd) > 0),
      };
    },

    /** What the proxy knows about one key: its spend to date, its budget, its alias. */
    async keyInfo(key) {
      const answer = await call("GET", "/key/info", { query: { key: String(key ?? "") } });
      if (!answer.ok) return answer;
      const info = answer.body?.info ?? answer.body ?? {};
      return {
        ok: true,
        alias: String(info?.key_alias ?? ""),
        keyId: String(info?.token ?? info?.token_id ?? ""),
        spend: pick(info, ["spend", "total_spend", "spend_usd"]),
        maxBudget: pick(info, ["max_budget"]),
        softBudget: pick(info, ["soft_budget"]),
        models: Array.isArray(info?.models) ? info.models.map(String) : [],
      };
    },

    /**
     * Revocation, by alias rather than by key value.
     *
     * The alias is derivable from the slug and the key value is in a 0600 file this service may or
     * may not still be able to read, so the alias is the handle that always works. It is also what
     * makes "revoke a customer I have already deleted the directory of" a thing an operator can
     * do.
     */
    async deleteKeyByAlias(slug) {
      const alias = proxyKeyAlias(slug);
      const answer = await call("POST", "/key/delete", { body: { key_aliases: [alias] } });
      if (!answer.ok) return answer;
      return { ok: true, alias, deleted: answer.body?.deleted_keys ?? answer.body ?? null };
    },

    /** A budget or a rate limit changed on a key that already exists. Used by the enforce sweep. */
    async updateKey({ key, allowanceUsd = 0, enforce = false, rpmLimit = 0, models = null }) {
      const body = { key: String(key ?? "") };
      if (Number(allowanceUsd) > 0) {
        if (enforce) body.max_budget = Number(allowanceUsd);
        else body.soft_budget = Number(allowanceUsd);
      }
      if (Number(rpmLimit) > 0) body.rpm_limit = Number(rpmLimit);
      if (Array.isArray(models)) body.models = [...models];
      return call("POST", "/key/update", { body });
    },

    /**
     * Spend over a window, grouped by key.
     *
     * NOT /spend/logs. That table is batch written (proxy_batch_write_at, ten seconds on this
     * install) and reading it straight after a request is how an assertion flakes. The report is
     * read from the same batches but it is the aggregate, so it is the honest thing to show and
     * the honest thing to wait on.
     */
    async spendReport({ startDay, endDay }) {
      const answer = await call("GET", "/global/spend/report", {
        query: { start_date: String(startDay), end_date: String(endDay), group_by: "api_key" },
      });
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body) ? answer.body
        : Array.isArray(answer.body?.spend_per_api_key) ? answer.body.spend_per_api_key
        : Array.isArray(answer.body?.results) ? answer.body.results
        : [];
      // One row per key, in the field names this service uses, with the many names LiteLLM has
      // used for the same two numbers folded into two.
      const keys = rows.map((row) => ({
        keyId: String(row?.api_key ?? row?.key ?? row?.token ?? ""),
        alias: String(row?.key_alias ?? row?.api_key_alias ?? row?.alias ?? ""),
        dollars: pick(row, ["total_spend", "spend", "total_cost", "cost"]),
        requests: pick(row, ["total_requests", "requests", "api_requests", "successful_requests"]),
        // Per model, when this build reports it. The TinyFish column needs it and nothing else
        // does, so an absent breakdown is a "not measured" on one column rather than a failure.
        models: Array.isArray(row?.metadata?.models ?? row?.models)
          ? (row?.metadata?.models ?? row?.models).map((entry) => ({
            model: String(entry?.model ?? entry?.model_name ?? entry ?? ""),
            requests: pick(entry, ["total_requests", "requests", "api_requests"]),
            dollars: pick(entry, ["total_spend", "spend", "total_cost"]),
          }))
          : [],
      })).filter((row) => row.keyId.length > 0 || row.alias.length > 0);
      return { ok: true, keys, startDay: String(startDay), endDay: String(endDay) };
    },

    /**
     * Which plan models this proxy actually serves, and how big their context is.
     *
     * /model/info is asked first because it carries max_input_tokens, which is the measured context
     * window rather than the number written down in this file. A build that does not answer it
     * falls back to the plain model list, and the fallback numbers above are used instead. Only
     * plan- prefixed names come back: a customer's own provider is never in here, and neither is
     * anything the operator has added to the proxy for their own use.
     */
    async models() {
      const detail = await call("GET", "/model/info");
      if (detail.ok) {
        const rows = Array.isArray(detail.body?.data) ? detail.body.data : [];
        const models = rows
          .map((row) => String(row?.model_name ?? ""))
          .filter((id) => isPlanModel(id));
        const windows = new Map();
        for (const row of rows) {
          const id = String(row?.model_name ?? "");
          if (!isPlanModel(id)) continue;
          const window = pick(row?.model_info ?? {}, ["max_input_tokens", "max_tokens"]);
          if (window !== null && (windows.get(id) ?? 0) < window) windows.set(id, window);
        }
        // The same model_name twice is the pool: two Z.AI subscriptions are two model_list entries
        // under one name, which is what MARKET-5's "one key per provider on the console" answer
        // rests on. So the list is de-duplicated here and the pool is invisible above this line.
        return { ok: true, models: [...new Set(models)], windows: Object.fromEntries(windows), from: "/model/info" };
      }
      const listed = await call("GET", "/v1/models");
      if (!listed.ok) return listed;
      const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
      const models = rows.map((row) => String(row?.id ?? "")).filter((id) => isPlanModel(id));
      return { ok: true, models: [...new Set(models)], windows: {}, from: "/v1/models" };
    },

    /** Is it up. The one call the installer and the System panel both make. */
    async readiness() {
      const answer = await call("GET", "/health/readiness");
      if (!answer.ok) return answer;
      return {
        ok: true,
        status: String(answer.body?.status ?? "unknown"),
        version: String(answer.body?.litellm_version ?? ""),
        db: answer.body?.db ?? null,
      };
    },
  };
}

/**
 * The rows the registry hands the relay, built from what a mint wrote down.
 *
 * PINNED. These field names are read by the relay (ui/) and asserted by tests/cp-relay-pair.
 * `id` EQUALS `model` on purpose, so there is one string rather than two that can drift: the
 * console's endpoint rows are keyed by id and the box's MODEL is the model, and making them the
 * same value removes a whole class of "the picker says one thing and the box runs another".
 */
export function includedModelRows({ models = [], windows = {} } = {}) {
  return models.filter(isPlanModel).map((id) => {
    const known = PLAN_MODELS[id] ?? null;
    return {
      id,
      model: id,
      name: known?.name ?? `${id} (included with your plan)`,
      contextWindow: numberOrNull(windows?.[id]) ?? known?.contextWindow ?? null,
      servedBy: known?.servedBy ?? id,
    };
  });
}
