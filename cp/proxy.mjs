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
// `modelLabel` is what the customer's own Titan says it is running when asked. NOT the model id:
// on the plan that id is `plan-zai`, a routing alias that exists so the proxy can pick a pool and
// so the console can tell an included row from a customer's own row, and reading it back to a
// customer hands them a fact about our plumbing as the answer to "what are you". Measured on the
// R750 2026-09-08: every box carried SAND_OPENAI_COMPATIBLE_MODEL = plan-zai and the persona note
// composed "model 'plan-zai'". The label is the name of the thing, and it is true.
//
// contextWindow here is the FALLBACK. The measured number comes from the proxy's own /model/info,
// which reports max_input_tokens per model out of the model list it was configured with, and that
// is what gets written down when it answers. These numbers are what a card shows when it does not.
export const PLAN_MODELS = Object.freeze({
  "plan-zai": Object.freeze({
    name: "Z.AI GLM (included with your plan)",
    modelLabel: "GLM-4.6",
    servedBy: "Z.AI GLM",
    contextWindow: 200_000,
  }),
  "plan-minimax": Object.freeze({
    name: "MiniMax M3 (included with your plan)",
    modelLabel: "MiniMax-M3",
    servedBy: "MiniMax M3",
    contextWindow: 200_000,
  }),
  "plan-qwen": Object.freeze({
    name: "Qwen (included with your plan)",
    modelLabel: "Qwen",
    servedBy: "Qwen",
    contextWindow: 128_000,
  }),
});

// The alias a tenant's key carries at the proxy. Derived from the slug rather than stored in a
// column, which is the whole reason this wave adds no schema change: /key/delete takes aliases, so
// the alias is the handle, and a handle you can compute is a handle that cannot go stale.
export const proxyKeyAlias = (slug) => `titanbot-${String(slug ?? "").trim()}`;

// THERE IS NO TAG ON A KEY, and this comment is here so nobody adds one back. The merged design
// said the mint would carry tags: ["tenant:<slug>"]. Measured at integration on 2026-09-08 against
// the real image: /key/generate with `tags` answers 403, "only available for LiteLLM Enterprise
// users: tags", so on the open source build that provisioning step cannot succeed at all. The
// tenant travels in key_alias and metadata instead, which is where the spend panel reads it from
// anyway, and the spend report is grouped by api_key rather than by tag.

// The MCP servers a tenant's virtual key is allowed to reach, which must match the names in the
// proxy's own config.yaml. One today.
export const MCP_SERVERS = Object.freeze(["tinyfish"]);

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
      // MEASURED ON THE R750 2026-09-08: LiteLLM's enterprise refusals come back as
      // {detail: {error: "<a sentence>"}}, and this chain read `detail.error.message` (absent),
      // then `detail` (an object), and String()'d it. Every client's spend window in the admin
      // console said "the proxy answered 400: [object Object]", which tells the operator nothing
      // at all and hid a real answer, that the endpoint is enterprise-only. Candidates now include
      // the string forms, and anything that is still not a string is dropped rather than stringified.
      const said = [
        parsed?.error?.message, parsed?.detail?.error?.message, parsed?.detail?.error,
        parsed?.detail?.message, parsed?.detail, parsed?.error, parsed?.message,
      ].find((one) => typeof one === "string" && one.length > 0)?.split("\n")[0].slice(0, 300) ?? "";
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
        models: [...models],
        metadata: { slug: String(slug), box: String(box ?? "") },
        // The MCP grant. Measured at integration on 2026-09-08 against the real
        // docker.litellm.ai/berriai/litellm-database:v1.100.0: a key minted WITHOUT this sees an
        // EMPTY tool list over the /mcp/ mount and gets HTTP 200 while doing it, so a customer's
        // TinyFish connector would report healthy and offer nothing. `allowed_mcp_servers` is
        // accepted by the mint and then silently ignored; `object_permission` is the one that
        // works. Anything that mints a key here must assert a non-empty tool list rather than a 200.
        object_permission: { mcp_servers: [...MCP_SERVERS] },
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
      // NOT /global/spend/report. MEASURED ON THE R750 2026-09-08 against the image we actually
      // run: that endpoint answers 400, "/spend/report endpoint You must be a LiteLLM Enterprise
      // user to use this feature". It is the third enterprise-gated surface this wave's design
      // assumed, after `tags` on a mint and tag budgets, and it is the one the whole spend panel
      // was built on: every client's two windows came back as a refusal a person could not read.
      //
      // /spend/logs is open, and it is better evidence anyway. It answers one row per REQUEST with
      // the key hash, the dollars, the model and the timestamp, so the two windows and the per
      // model breakdown are all computed from the same rows rather than from three endpoints that
      // can disagree. The aggregation is here so cp/admin.mjs is unchanged: same shape out.
      //
      // Deliberately called with NO date parameters. Measured the same day: adding start_date and
      // end_date changes the ANSWER SHAPE, from a list of requests to a per-day aggregate with one
      // column per key hash, which is a second parser for the same numbers. The filtering is done
      // here on startTime instead. See docs/PROXY.md for the bound this leaves unset.
      const answer = await call("GET", "/spend/logs");
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body) ? answer.body : [];
      const from = String(startDay);
      const to = String(endDay);
      const byKey = new Map();
      for (const row of rows) {
        // The calendar day the request happened on, in UTC, which is what the windows are in.
        const day = String(row?.startTime ?? row?.startTimeUtc ?? "").slice(0, 10);
        if (day.length !== 10 || day < from || day > to) continue;
        const keyId = String(row?.api_key ?? row?.key ?? row?.token ?? "");
        if (keyId.length === 0) continue;
        let entry = byKey.get(keyId);
        if (entry == null) {
          entry = { keyId, alias: "", dollars: 0, requests: 0, byModel: new Map() };
          byKey.set(keyId, entry);
        }
        const dollars = Number(row?.spend ?? 0) || 0;
        entry.dollars += dollars;
        entry.requests += 1;
        const alias = String(row?.key_alias ?? row?.metadata?.user_api_key_alias ?? "");
        if (alias.length > 0) entry.alias = alias;
        // The model as the proxy recorded it. A pass-through request records its PATH here, which
        // is what lets the TinyFish column be counted at all.
        const model = String(row?.model ?? row?.model_group ?? "");
        const seen = entry.byModel.get(model) ?? { model, requests: 0, dollars: 0 };
        seen.requests += 1;
        seen.dollars += dollars;
        entry.byModel.set(model, seen);
      }
      const keys = [...byKey.values()].map((entry) => ({
        keyId: entry.keyId,
        alias: entry.alias,
        // Rounded to the cent-of-a-cent the panel prints. Summing floats over a month otherwise
        // shows a customer a number with fifteen decimal places in it.
        dollars: Math.round(entry.dollars * 1e6) / 1e6,
        requests: entry.requests,
        models: [...entry.byModel.values()].map((row) => ({
          model: row.model,
          requests: row.requests,
          dollars: Math.round(row.dollars * 1e6) / 1e6,
        })),
      }));
      return { ok: true, keys, startDay: from, endDay: to };
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
      // What the box tells the customer it is running. Falls back to the id, which is what every
      // row did before this field existed, so an unknown plan model is no worse than it was.
      modelLabel: known?.modelLabel ?? id,
    };
  });
}
