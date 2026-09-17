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
    modelLabel: "GLM-5.3",
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

// ---- PROVIDERS-1: the providers this product already knows how to talk to -----------------------
//
// A STARTING POINT, NOT A REGISTER. The live register is the proxy's own database, and the operator
// adds providers from the panel. This is what the panel offers before anybody has: the three base
// urls and vendor prefixes that were measured against real subscriptions, so adding a Z.AI key is
// picking a name and pasting a key rather than remembering an api_base.
//
// `kind` is the LiteLLM prefix a new plan model gets. Z.AI and Alibaba both speak the OpenAI shape
// behind their own base url, so both are openai/; MiniMax has its own provider in LiteLLM and takes
// no api_base at all, which is why baseUrl is empty for it rather than guessed.
//
// `catalogPath` is the vendor's own model list, read through a pass-through so this container never
// holds the key. Empty means there is none to read and the curated list is the whole answer, and
// the panel says which of the two it is showing in those words.
//
// `curated` is short on purpose. It is what the operator can pick from before a Refresh, and every
// id in it is one that has actually answered on this product's own subscriptions. A longer list
// copied out of a vendor's documentation would be a list of names that may not be on this plan.
//
// `bootstrapEnv` is the ~/.api_keys name a FRESH install seeds this provider's first key from, and
// nothing else. Live keys go in through the panel. QWEN_API_KEY and the two TinyFish names are
// written down here so the slot exists the moment Jason syncs them from Bitwarden; nothing goes
// looking for them and their absence is not an error.
export const PROVIDER_PRESETS = Object.freeze({
  zai: Object.freeze({
    name: "Z.AI",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    catalogPath: "/models",
    // MEASURED on grok-bot-local-vm 2026-09-08: the coding plan endpoint's own /models answers ten
    // ids. These are the ones this product has run. glm-5.3-flash and glm-4.6v are the two that
    // take an image part; the rest refuse one with code 1210, which is what plan-zai-vision exists
    // for and what PROXY-10 cost a day.
    curated: Object.freeze(["glm-5.3", "glm-5.3-flash", "glm-5", "glm-4.7", "glm-4.6", "glm-4.6v"]),
    bootstrapEnv: Object.freeze(["ZAI_API_KEY", "ZAI_API_KEY_JASON"]),
  }),
  minimax: Object.freeze({
    name: "MiniMax",
    kind: "minimax",
    // Empty because the deployment must NOT carry one: LiteLLM's own minimax provider knows where
    // MiniMax is, and an api_base here would override it. The catalog still has an address, which
    // is why the two are separate fields rather than one.
    baseUrl: "",
    catalogBaseUrl: "https://api.minimax.io/v1",
    catalogPath: "/models",
    curated: Object.freeze(["MiniMax-M3"]),
    bootstrapEnv: Object.freeze(["MINIMAX_API_KEY"]),
  }),
  qwen: Object.freeze({
    name: "Alibaba Model Studio",
    kind: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    catalogPath: "/models",
    // One id, because one is what has answered. The token plan's own page lists more; a Refresh
    // reads the real list the moment a key is in, and until then a short true list beats a long
    // guessed one.
    curated: Object.freeze(["qwen3.8-max"]),
    bootstrapEnv: Object.freeze(["QWEN_API_KEY"]),
  }),
  // THE TWO REALTIME ROWS THAT USED TO BE HERE ARE GONE, and their own comment named deleting them
  // as the right answer if they ever became more than cosmetic. They became worse than cosmetic.
  //
  // MEASURED BY JASON in the live admin console, 2026-09-10 07:49. He pasted a real xAI realtime key
  // on the "xAI realtime (voice)" row and the panel answered: "xAI realtime (voice) would not accept
  // that key, so nothing was stored. xAI realtime (voice) could not be reached (fetch failed)." The
  // panel proves a key before storing it by fetching the row's catalog path, this row's address is
  // `wss://api.x.ai/v1/realtime`, and with catalogPath empty proveKey falls through to POSTing a
  // websocket address over HTTP. So the row could never take a key, and it read to the operator as
  // a vendor outage. A control that cannot succeed is worse than no control: it sends the person
  // who owns the key to the wrong screen and then blames the vendor. PROVIDERS-10, VOICE-4.
  //
  // WHERE THE REALTIME KEY GOES INSTEAD: the "Keys the product uses" block on the Keys panel of this
  // same console (it was appended to System health until KEYS-2 gave it its own rail entry). It proves an xAI key against https://api.x.ai/v1/models and an
  // OpenAI key against https://api.openai.com/v1/models -- the same key serves chat and realtime at
  // both vendors -- stores it write-only, and the ONE relay reads it behind CP_RELAY_TOKEN.
  // cp/secrets.mjs is that door and docs/VOICE.md section 2 is the reasoning.
  //
  // DO NOT PUT THEM BACK. A spoken session does not go through the proxy and never will: it is a
  // websocket carrying audio frames and LiteLLM has no deployment shape for one. cp/voice.mjs
  // REALTIME_VENDORS is still the authoritative table of what this product can talk to, and the CLI
  // and docs/VOICE.md both name it.
});

/**
 * The vendor's own plan window, per provider, and what is honestly knowable about it.
 *
 * Jason, 2026-09-08, over a screenshot of Alibaba Model Studio's Token Plan Usage page showing
 * "Remaining 42.9% of Total 40,000, resets 2026-09-09 22:37": "WE need to be tracking this. and
 * tracking per account."
 *
 * Two things are being asked for and they are not the same thing. What the VENDOR says is left in
 * the window, which only the vendor knows; and what OUR OWN customers consumed inside it, which
 * only the proxy's per-key log knows. The second is measured here for every provider. The first is
 * measured only where the vendor serves it, and where it does not, this product's own count is
 * shown and is LABELLED AN ESTIMATE rather than dressed up as the vendor's number.
 *
 * `unit` is the vendor's own unit, because a bar drawn in one unit against a page written in
 * another is a bar that will be read wrong. Alibaba's plan counts thousands of tokens; Z.AI's
 * coding plan counts prompts inside a five hour window and a month.
 *
 * `usagePath` is the vendor's own usage endpoint, read through the same pass-through the catalog
 * uses. It is EMPTY on all three today, and that is a measurement rather than a gap somebody has not
 * got to. MEASURED on this Mac 2026-09-08 with the real keys from ~/.api_keys, values never printed:
 *
 *   Z.AI     GET /api/coding/paas/v4/usage        404   {"error":"Not Found","path":"/v4/usage"}
 *            GET /api/coding/paas/v4/subscription 404   the same shape
 *            GET /api/monitoring/v1/usage         200 carrying {"code":500,"msg":"404 NOT_FOUND"}
 *   MiniMax  GET /v1/usage                        404   "404 page not found"
 *
 * while GET /models answered 200 on both in the same sweep, so the keys are live and the paths are
 * not there. Alibaba's token plan page was not probed because Jason has rotated that key and the new
 * one is not synced yet; its slot is here and its endpoint is unmeasured, said in those words.
 *
 * So on this build every quota bar is OUR OWN COUNT out of the proxy's per-key log, and the panel
 * says so on the bar rather than in a footnote. When a vendor endpoint is found, filling in
 * usagePath is the whole change and the bar becomes the vendor's own number.
 */
export const PROVIDER_QUOTA = Object.freeze({
  zai: Object.freeze({
    unit: "prompts",
    windows: Object.freeze(["5 hours", "a month"]),
    usagePath: "",
    why: "Z.AI's coding plan counts prompts in a five hour window and again over a month. This product has not measured an endpoint that reports them, so the number here is our own count of requests through this key.",
  }),
  qwen: Object.freeze({
    unit: "thousands of tokens",
    windows: Object.freeze(["7 days"]),
    usagePath: "",
    why: "Alibaba's token plan is a seven day rolling limit with a reset time. This product has not measured an endpoint that reports it, so the number here is our own count of tokens through this key and the vendor's page is still the authority.",
  }),
  minimax: Object.freeze({
    unit: "requests",
    windows: Object.freeze(["a month"]),
    usagePath: "",
    why: "MiniMax bills this subscription per request. The number here is our own count through this key.",
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

/**
 * Where a screenshot-carrying turn on this deployment actually goes, or "" for nowhere.
 *
 * A DEPLOYMENT THAT NAMES ITSELF HAS NO FALLBACK, and this is the one place that decides it. The
 * stored tb_vision_fallback is a name somebody typed into the Providers panel, and plan-minimax
 * shipped on the R750 with its own alias in it: the panel's "name a model a screenshot falls back
 * to" guard was satisfied and no route existed. Every control plane start then read that value
 * back, tried to write it, and the proxy refused it -- `Model 'plan-minimax' cannot be its own
 * fallback` -- so every boot printed an error with nothing behind it to act on.
 *
 * Self-naming is still an allowed thing to SAY, on one deployment only: a model whose vision check
 * has passed says "images stop here" that way (see the vision_unproved refusal in cp/admin.mjs).
 * What it never means is a second model to route to, so everything that resolves a route reads it
 * through here and a plan model with no other plan to fall back to simply has none.
 */
export const visionFallbackTarget = (row) => {
  const alias = String(row?.alias ?? "");
  const target = String(row?.visionFallback ?? "");
  return target.length === 0 || target === alias ? "" : target;
};
export const isTalkPlanModel = (id) => isPlanModel(id) && String(id).endsWith("-talk");
// ROUTER-1c: every caller hands in the list the proxy SAID it serves, and that list already
// carries `<plan>-talk` whenever the deployment exists. Inventing the sibling here granted
// plan-qwen-talk to keys on 2026-09-12, the host trusted /models, and the proxy answered 400 on
// Jason's voice turns. A key is scoped to what the proxy serves, nothing more.
export const planModelTier = (id) => isTalkPlanModel(id) ? "talk"
  : isPlanModel(id) && !String(id).endsWith("-vision") ? "work" : null;

// ---- PROVIDERS-1: what a tenant's key may call ---------------------------------------------------
//
// THE BOUNDARY MOVED FROM THE FILE TO THE KEY, and this list is the new boundary.
//
// Until this wave the only door was general_settings.allowed_routes in the proxy's config file. It
// is checked in pre_db_read_auth_checks BEFORE the key is looked up, so it is ONE GLOBAL LIST that
// refuses the master key too and cannot tell a tenant from the operator. That is exactly why
// PROXY-8 was open: /key/info and /model/info had to stay open to every virtual key on the bridge
// because the control plane called them.
//
// MEASURED ON THIS MAC 2026-09-08 against a throwaway docker.litellm.ai/berriai/litellm-database:
// v1.100.0 stack, which is the image the R750 runs. A key minted with this list answers
//
//   403 "Virtual key is not allowed to call this route. Only allowed to call routes: [...]"
//
// on /key/info, /model/info, /model_group/info, /health, /spend/logs and /settings, while
// GET /v1/models and POST /v1/chat/completions answer 200 and the MASTER key is unaffected. It
// closes /health to tenants at the same time, which was the global list's real job: a
// tenant-triggered /health sweep makes a live call to every provider deployment on the operator's
// own subscriptions, and on the R750 2026-09-08 one sweep put three rows in /spend/logs under
// litellm-internal-health-check, $0.000043, charged to the operator and attributed to no tenant.
//
// THE PASS-THROUGHS ARE IN THE LIST ON PURPOSE. The match is an exact string on the REGISTERED
// path, measured the same day: a key carrying /tinyfish/search reached the target, and the same key
// was refused 403 on /catalog/zai/models, which is a pass-through it does not carry. Leaving the
// TinyFish paths out would take a customer's web tools away with a 403 nobody could read.
//
// ORDERING IS LOAD BEARING AND IS IN THE SHIP PLAN. Every key already in the field was minted with
// allowed_routes [] and is unrestricted. The backfill (cp/cli.mjs proxy limits --all) has to push
// this list onto those keys BEFORE the global list is taken out of config.yaml, never after, or
// there is a window where the admin surface is open to every box on the bridge.
export const TENANT_ALLOWED_ROUTES = Object.freeze([
  // inference, which is the whole reason the key exists
  "/v1/chat/completions",
  "/chat/completions",
  // the box asks what it can run
  "/v1/models",
  "/models",
  // TinyFish, the two metered pass-throughs and the MCP mount
  "/tinyfish/fetch",
  "/tinyfish/search",
  "/mcp",
  "/mcp/",
]);

/** The TinyFish half of the list above, which is the half that depends on a key existing. */
export const TINYFISH_ROUTES = Object.freeze(["/tinyfish/fetch", "/tinyfish/search", "/mcp", "/mcp/"]);

/**
 * The door list a tenant key is really minted with, given what the proxy is really carrying.
 *
 * A DOOR WITHOUT A KEY BEHIND IT IS NOT A FEATURE, it is a 401 the customer pays for. MEASURED ON
 * THE R750 2026-09-08: PROXY_TINYFISH_KEY_1 is a bare newline, so /tinyfish/fetch and
 * /tinyfish/search were serving with `x-api-key: ""` -- an unauthenticated request wearing a
 * costume, in config.yaml's own words about the second pair it deliberately did NOT ship for
 * exactly this reason. Every tenant key carried both paths anyway, and each call booked a metered
 * request on its way to failing.
 *
 * So the TinyFish routes go on a key when the proxy's own pass-through rows say the header holds
 * something, and not before. The moment PROXY-7's key is set the next mint (and `proxy limits
 * --all`) puts them back with no code change. When the pass-through list cannot be read at all the
 * routes are LEFT ON: a proxy that will not answer this question is not evidence that a working
 * door should be taken away from a customer mid-turn.
 */
export function tenantRoutesFor(passThrough) {
  if (passThrough?.ok !== true) return [...TENANT_ALLOWED_ROUTES];
  const rows = Array.isArray(passThrough.rows) ? passThrough.rows : [];
  const carries = (row) => Object.entries(row?.headerSet ?? {})
    // content-type is not a credential, which is why a row holding only that one fails this.
    .some(([name, has]) => has === true && String(name).toLowerCase() !== "content-type");
  const usable = new Set(rows.filter(carries).map((row) => String(row.path)));
  // The MCP mount is NOT a pass-through: it is `mcp_servers.tinyfish` in config.yaml, and it takes
  // its credential from the SAME environment name the two TinyFish pass-throughs do. So the
  // pass-throughs are the readable proxy for whether that name is set, and the mount is dropped
  // only when TinyFish doors exist and every one of them is empty. When there are none at all --
  // a proxy configured some other way -- nothing is inferred and the mount stays.
  const tinyfish = rows.filter((row) => String(row.path ?? "").startsWith("/tinyfish/"));
  const tinyfishDead = tinyfish.length > 0 && !tinyfish.some(carries);
  return TENANT_ALLOWED_ROUTES.filter((route) => {
    if (!TINYFISH_ROUTES.includes(route)) return true;
    if (route.startsWith("/mcp")) return !tinyfishDead;
    return usable.has(route);
  });
}

// The model_info keys this product writes on a deployment, and the reason they can be written at
// all: MEASURED ON THIS MAC 2026-09-08, model_info accepts arbitrary keys and round-trips them
// byte for byte through /model/new, /model/update and /model/info. So everything the product needs
// to know about a plan model rides with the deployment rather than in a second store that can drift
// away from it.
//
// tb_ rather than a bare name, because these sit beside LiteLLM's own model_info fields and a
// collision on a future upgrade would be silent.
export const TB = Object.freeze({
  provider: "tb_provider",
  keyLabel: "tb_key_label",
  keyOrder: "tb_key_order",
  keySlot: "tb_key_slot",
  customerName: "tb_customer_name",
  customerLabel: "tb_customer_label",
  servedBy: "tb_served_by",
  customerVisible: "tb_customer_visible",
  visionFallback: "tb_vision_fallback",
  visionOk: "tb_vision_ok",
  visionAt: "tb_vision_at",
  plans: "tb_plans",
});

// What LiteLLM says when a deployment write lands on a proxy whose flag is off. MEASURED ON THIS
// MAC 2026-09-08: POST /model/new answers 500 with exactly this sentence inside its message, while
// POST /credentials answers 200 and really does persist. So the flag gates the DEPLOYMENT half and
// not the credential half, and a seed that ignored this would write half a configuration and report
// success.
export const STORE_MODEL_IN_DB_REFUSAL = "STORE_MODEL_IN_DB";

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

/**
 * One /model/info row, in this product's words.
 *
 * `alias` is the string a box runs on and `vendorModel` is the thing behind it, and keeping the two
 * named differently everywhere above this line is what stops the internal alias reaching a customer
 * page by accident.
 *
 * NOTE ON litellm_params.model: on a DB-backed deployment the proxy answers /model/new and
 * /model/update with an ENCRYPTED blob in that field, and the readable value only on /model/info.
 * MEASURED ON THIS MAC 2026-09-08. So the vendor model is read from here and never from a write's
 * own answer.
 */
export function normalizeDeployment(row) {
  const params = row?.litellm_params ?? {};
  const info = row?.model_info ?? {};
  return {
    id: String(info?.id ?? ""),
    alias: String(row?.model_name ?? ""),
    vendorModel: String(params?.model ?? ""),
    credentialName: String(params?.litellm_credential_name ?? ""),
    baseUrl: String(params?.api_base ?? ""),
    // PROVIDERS-1. What a request on this deployment COSTS, which decides whether any dollar figure
    // downstream means anything. MEASURED ON THE R750 2026-09-08: every Z.AI deployment was created
    // with no price at all and LiteLLM has no built-in price for a Z.AI model id, so 654 spend rows
    // carried spend 0.000000 and the panel drew $0.00 for a customer at 665,915 tokens. A missing
    // price is reported as null here so the pages above can say "not priced" instead of "$0.00" --
    // the two look identical on a screen and mean opposite things.
    inputCostPerToken: numberOrNull(params?.input_cost_per_token),
    outputCostPerToken: numberOrNull(params?.output_cost_per_token),
    fromDb: info?.db_model === true,
    contextWindow: numberOrNull(info?.max_input_tokens),
    supportsVision: info?.supports_vision === true,
    provider: String(info?.[TB.provider] ?? ""),
    keySlot: String(info?.[TB.keySlot] ?? info?.[TB.keyLabel] ?? ""),
    keyLabel: String(info?.[TB.keyLabel] ?? ""),
    keyOrder: numberOrNull(info?.[TB.keyOrder]),
    customerName: String(info?.[TB.customerName] ?? ""),
    customerLabel: String(info?.[TB.customerLabel] ?? ""),
    servedBy: String(info?.[TB.servedBy] ?? ""),
    // ABSENT MEANS NOT VISIBLE, deliberately. A deployment somebody added by hand with no tb_ keys
    // on it is a routing target, and defaulting an unknown row to visible is exactly how an
    // internal alias reaches a customer's Settings page.
    customerVisible: info?.[TB.customerVisible] === true,
    // Whether anybody has EVER said anything about this row, which is not the same question as
    // whether it is visible. A deployment the proxy read out of its config file carries no tb_ key
    // at all, and on the R750 that is every deployment until the seed runs. Telling "nobody has
    // named this" apart from "somebody named this and marked it hidden" is what lets PLAN_MODELS
    // stay the fallback register for the three ids that already exist, so an upgrade is not a
    // cliff, while a NEW alias nobody has named still stays off a customer's page.
    named: info?.[TB.customerVisible] !== undefined
      || String(info?.[TB.customerLabel] ?? "").length > 0
      || String(info?.[TB.customerName] ?? "").length > 0,
    visionFallback: String(info?.[TB.visionFallback] ?? ""),
    visionOk: info?.[TB.visionOk] === true,
    visionAt: String(info?.[TB.visionAt] ?? ""),
    plans: Array.isArray(info?.[TB.plans]) ? info[TB.plans].map(String) : [],
  };
}

/** One /credentials row. The value is already masked by the proxy and is passed through as it came. */
export function normalizeCredential(row) {
  const values = row?.credential_values ?? {};
  const info = row?.credential_info ?? {};
  return {
    name: String(row?.credential_name ?? ""),
    masked: String(values?.api_key ?? ""),
    baseUrl: String(values?.api_base ?? ""),
    provider: String(info?.[TB.provider] ?? ""),
    label: String(info?.[TB.keyLabel] ?? ""),
    order: numberOrNull(info?.[TB.keyOrder]),
    parked: info?.tb_parked === true,
  };
}

/**
 * A refusal that is really the flag being off, said in words rather than as a 500.
 *
 * MEASURED ON THIS MAC 2026-09-08: the sentence LiteLLM returns is
 * `Set 'STORE_MODEL_IN_DB='True' in your env to enable this feature.` wrapped in a 500 whose type
 * is "auth_error", which reads like a credential problem and is not one. Anybody hitting this at
 * 2am should be told the actual thing to change.
 */
function withDbHint(answer) {
  if (answer.ok) return answer;
  if (!String(answer.why ?? "").includes(STORE_MODEL_IN_DB_REFUSAL)) return answer;
  return {
    ...answer,
    dbOff: true,
    why: "the proxy is not storing its model list in its database, so this change would not take. Set STORE_MODEL_IN_DB=True on the proxy service and turn on store_model_in_db in its config, then try again",
  };
}

// The first instant of this UTC month, as a day string. The panel says "this month" and this is
// what that means: calendar month, UTC, not a rolling thirty days, because a customer's allowance
// is a monthly allowance and a rolling window would never line up with it.
export function monthStartDay(at) {
  const date = new Date(at);
  return `${date.toISOString().slice(0, 7)}-01`;
}

// PROVIDERS-8. How many of a deployment's most recent requests the spend sweep carries back.
//
// A month total cannot tell a provider that is broken right now from one that broke on the 8th and
// has answered every request since. MEASURED ON THE R750 2026-09-09 out of the proxy's own
// database: tb-plan-qwen-qwen-1 holds 254 rows and 3 failures, all three on 2026-09-08 (22:45:34,
// 22:47:11 and 22:48:09), and the twelve newest are all success -- while the panel said "not
// answering" because one failure anywhere in the window turned the light red. Five is enough to
// tell a vendor that is down from one bad request and small enough to keep per deployment for
// every row in the log.
export const RECENT_REQUESTS = 5;

/**
 * The newest RECENT_REQUESTS entries, kept as an insert rather than an append.
 *
 * /spend/logs is NOT ordered and the loop that fills this does not sort, so appending would keep
 * whichever five rows happened to arrive last, which is a different set from the five that happened
 * last. The ring is held newest first and an entry that cannot get in is dropped.
 */
export function keepRecent(ring, entry) {
  let index = ring.length;
  while (index > 0 && String(ring[index - 1].at) < String(entry.at)) index -= 1;
  if (index >= RECENT_REQUESTS) return ring;
  ring.splice(index, 0, entry);
  if (ring.length > RECENT_REQUESTS) ring.length = RECENT_REQUESTS;
  return ring;
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

  async function listPassThrough() {
    const answer = await call("GET", "/config/pass_through_endpoint");
    if (!answer.ok) return answer;
    const rows = Array.isArray(answer.body?.endpoints) ? answer.body.endpoints : [];
    return {
      ok: true,
      rows: rows.map((row) => ({
        id: String(row?.id ?? ""),
        path: String(row?.path ?? ""),
        target: String(row?.target ?? ""),
        includeSubpath: row?.include_subpath === true,
        costPerRequest: numberOrNull(row?.cost_per_request),
        fromConfig: row?.is_from_config === true,
        // The NAMES of the headers it carries and never their values, so the panel can say "this
        // one carries a key" without being the thing that shows it.
        headerNames: Object.keys(row?.headers ?? {}).map(String),
        // WHETHER EACH HEADER ACTUALLY HOLDS SOMETHING, which is a different question from
        // whether it exists, and it is the one that decides whether a door works.
        //
        // MEASURED ON THE R750 2026-09-08: /tinyfish/fetch and /tinyfish/search were live with
        // `x-api-key: ""` -- PROXY_TINYFISH_KEY_1 on the proxy service is a bare newline -- and
        // every tenant key carried both paths on its allow list. So every box could call a door
        // that could only ever fail upstream, and each attempt booked a metered request at
        // cost_per_request 0.0001. A boolean is safe to carry where the value is not.
        headerSet: Object.fromEntries(Object.entries(row?.headers ?? {}).map(([name, value]) => [String(name), String(value ?? "").trim().length > 0])),
      })),
    };
  }

  return {
    base,
    configured,
    call,

    // The allowance reader needs exact timestamps, so it consumes the request rows rather than a
    // calendar-day aggregate. The caller owns the 60-second cache shared by every workspace.
    async spendRows() {
      const answer = await call("GET", "/spend/logs");
      if (!answer.ok) return answer;
      return { ok: true, rows: Array.isArray(answer.body) ? answer.body : [] };
    },

    /**
     * One virtual key for one tenant.
     *
     * OBSERVE MODE IS THE DEFAULT AND IT IS NOT A HALF MEASURE. With CP_PROXY_ENFORCE unset the
     * key is minted with soft_budget, which by LiteLLM's own definition never fails a request but
     * does produce the number the 80 percent chip reads. Set CP_PROXY_ENFORCE and the same mint
     * sends max_budget, which does fail the request, and the box turns that into the plain
     * sentence about the plan being spent. Arming it is a separate decision from shipping this.
     */
    async mintKey({ slug, models = [], allowanceUsd = 0, enforce = false, rpmLimit = 0, box = "", allowedRoutes = null }) {
      const alias = proxyKeyAlias(slug);
      // WHEN THE CALLER DID NOT SAY, ASK THE PROXY. The list is the full one minus any pass-through
      // whose credential header is empty: on the R750 2026-09-08 the two TinyFish doors were live
      // with `x-api-key: ""` and every tenant key carried them, so every box could call a door that
      // could only fail upstream while booking a metered request. cp/provision.mjs mints without
      // naming a list, so this default is what a new customer actually gets.
      const routes = Array.isArray(allowedRoutes) ? allowedRoutes : tenantRoutesFor(await listPassThrough());
      const body = {
        key_alias: alias,
        models: [...new Set(models.map(String).filter(Boolean))],
        metadata: { slug: String(slug), box: String(box ?? "") },
        // PROXY-8's half of the fix, applied at mint. See TENANT_ALLOWED_ROUTES above for the
        // measurement and for why the ordering against the global list is load bearing.
        allowed_routes: [...routes],
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

    /**
     * A budget, a rate limit, a model list or a route list changed on a key that ALREADY EXISTS.
     *
     * `allowedRoutes` is what makes the PROXY-8 backfill a sweep rather than a fleet-wide rotate,
     * and whether it worked at all was the branch point the ship plan hangs on.
     *
     * MEASURED ON THIS MAC 2026-09-08 against a throwaway v1.100.0 stack: POST /key/update with
     * allowed_routes answers 200 and it TAKES ON THE SAME KEY VALUE. A key minted unrestricted, then
     * updated, answered 200 on /key/info before and 403 "Virtual key is not allowed to call this
     * route" after, while GET /v1/models kept answering 200 throughout and the master key was
     * unaffected. So the backfill writes NOTHING into a box: no re-mint, no new key value, no
     * 60 s registry hazard, and none of the migrate trouble that wrote a revoked key back into a
     * box on 2026-09-08. That is the good branch of the ship plan's step 2.
     */
    async updateKey({ key, allowanceUsd = 0, enforce = false, rpmLimit = 0, models = null, allowedRoutes = null }) {
      const body = { key: String(key ?? "") };
      if (Number(allowanceUsd) > 0) {
        if (enforce) body.max_budget = Number(allowanceUsd);
        else body.soft_budget = Number(allowanceUsd);
      }
      if (Number(rpmLimit) > 0) body.rpm_limit = Number(rpmLimit);
      if (Array.isArray(models)) body.models = [...new Set(models.map(String).filter(Boolean))];
      if (Array.isArray(allowedRoutes)) body.allowed_routes = [...allowedRoutes];
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
      // PROVIDERS-1. The SECOND grouping, off the same fetch and the same filter.
      //
      // The Providers panel wants per-KEY-SLOT spend and the Spend panel wants per-CUSTOMER spend,
      // and they are two groupings of one set of rows. Reading them from two calls is how two
      // panels come to disagree by a batch write, so there is one fetch and one loop here and the
      // callers pick the grouping they need. model_id is the deployment's own id, which is what
      // joins a spend row to a key slot: a pool is several deployments under one alias, so the
      // alias alone cannot say which subscription paid.
      const byDeployment = new Map();
      for (const row of rows) {
        // The calendar day the request happened on, in UTC, which is what the windows are in.
        const day = String(row?.startTime ?? row?.startTimeUtc ?? "").slice(0, 10);
        if (day.length !== 10 || day < from || day > to) continue;
        const keyId = String(row?.api_key ?? row?.key ?? row?.token ?? "");
        if (keyId.length === 0) continue;
        let entry = byKey.get(keyId);
        if (entry == null) {
          entry = { keyId, alias: "", dollars: 0, requests: 0, rows: 0, tokens: 0, tokensIn: 0, tokensOut: 0, byModel: new Map(), byGroup: new Map(), byUsage: new Map(), byDeployment: new Map() };
          byKey.set(keyId, entry);
        }
        const dollars = Number(row?.spend ?? 0) || 0;
        // ROWS AND REQUESTS ARE COUNTED SEPARATELY, and they are usually the same number.
        //
        // One log row is one request on every path this product uses today. But an upstream that
        // batches, or a future build that aggregates before writing, can put many requests on one
        // row, and a panel that counted rows would then quietly under-report. So the row's own
        // count is read where it carries one and the two numbers are both reported; when they
        // differ, that is the fact, and cp/admin.mjs shows it rather than picking one.
        const requests = Math.max(1, Number(row?.total_requests ?? row?.api_requests ?? 1) || 1);
        // TOKENS, for the vendor quota bars. Alibaba's token plan is counted in tokens and not in
        // dollars, so a bar drawn from spend would be a bar in the wrong unit. Absent on a
        // pass-through row and on any row the upstream did not report usage for, and absent adds
        // zero rather than guessing an average.
        const tokens = Math.max(0, Number(row?.total_tokens ?? 0) || 0)
          || (Math.max(0, Number(row?.prompt_tokens ?? 0) || 0) + Math.max(0, Number(row?.completion_tokens ?? 0) || 0));
        // Direction is kept separately for the Spend panel. Missing and malformed fields are zero:
        // old LiteLLM rows do not carry them, and allowing NaN into a monthly sum would poison every
        // workspace and fleet total after it.
        const tokensIn = Math.max(0, Number(row?.prompt_tokens ?? 0) || 0);
        const tokensOut = Math.max(0, Number(row?.completion_tokens ?? 0) || 0);
        entry.dollars += dollars;
        entry.requests += requests;
        entry.rows += 1;
        entry.tokens += tokens;
        entry.tokensIn += tokensIn;
        entry.tokensOut += tokensOut;
        const alias = String(row?.key_alias ?? row?.metadata?.user_api_key_alias ?? "");
        if (alias.length > 0) entry.alias = alias;
        // The model as the proxy recorded it. A pass-through request records its PATH here, which
        // is what lets the TinyFish column be counted at all.
        const model = String(row?.model ?? row?.model_group ?? "");
        const seen = entry.byModel.get(model) ?? { model, requests: 0, dollars: 0 };
        seen.requests += requests;
        seen.dollars += dollars;
        entry.byModel.set(model, seen);
        // The GROUP the request asked for, kept apart from the upstream model above. They are not
        // the same string and never were: a row records `plan-zai-talk` as its group and
        // `openai/glm-5.3-flash` as its model. "Runs on" filters for a plan alias, so reading it
        // off `model` matched nothing for any workspace and the field was empty fleet-wide.
        const group = String(row?.model_group ?? "").trim();
        if (group.length > 0) {
          const byGroup = entry.byGroup.get(group) ?? { group, requests: 0 };
          byGroup.requests += requests;
          entry.byGroup.set(group, byGroup);
        }
        // Prefer the provider recorded on the request. Some older rows only identify their
        // deployment; those retain an empty provider here so the control plane can fill it from
        // /model/info, and ultimately name the bucket "not recorded" if neither source can.
        const provider = String(row?.custom_llm_provider ?? row?.provider ?? "").trim();
        const deploymentId = String(row?.model_id ?? row?.model_info?.id ?? "");
        const usageKey = `${provider}\u0000${model}\u0000${deploymentId}`;
        const usage = entry.byUsage.get(usageKey) ?? { provider, model, deploymentId, tokensIn: 0, tokensOut: 0, calls: 0, cost: 0 };
        usage.tokensIn += tokensIn;
        usage.tokensOut += tokensOut;
        usage.calls += requests;
        usage.cost += dollars;
        entry.byUsage.set(usageKey, usage);
        // The deployment this request actually ran on. Absent on a pass-through row and on any
        // build that does not record it, and an absent id is left out rather than bucketed under
        // an empty string: a key slot's spend has to be spend that is really that slot's.
        if (deploymentId.length === 0) continue;
        let target = byDeployment.get(deploymentId);
        if (target == null) {
          target = { id: deploymentId, alias: model, dollars: 0, requests: 0, rows: 0, tokens: 0, failures: 0, lastFailureAt: "", lastFailureWhy: "", recent: [] };
          byDeployment.set(deploymentId, target);
        }
        target.dollars += dollars;
        target.requests += requests;
        target.rows += 1;
        target.tokens += tokens;
        // PROVIDERS-8. WHEN each of those outcomes happened, per deployment, inside the same
        // window. What the month total cannot say is whether the failures are the newest thing that
        // happened or the oldest, and that is the whole difference between a provider that is down
        // now and one that had a bad night last week.
        const startedAt = String(row?.startTime ?? row?.startTimeUtc ?? "");
        keepRecent(target.recent, { at: startedAt, ok: String(row?.status ?? "").toLowerCase() !== "failure" });
        // PROVIDERS-1, the honest half of provider health. A spend row carries the outcome of the
        // request it records, and a failed one is the only evidence this install HAS that a key or a
        // vendor is unwell: background_health_checks is off and GET /health/latest answers an empty
        // object (measured on the R750 2026-09-08, and 26 failure rows were in the log at the same
        // moment). Counted per deployment, which is per key slot, because that is the grain the
        // Providers panel draws.
        if (String(row?.status ?? "").toLowerCase() === "failure") {
          target.failures += 1;
          const at = startedAt;
          if (at > target.lastFailureAt) {
            target.lastFailureAt = at;
            target.lastFailureWhy = String(
              row?.metadata?.error_information?.error_message
              ?? row?.metadata?.error_information?.error_class
              ?? row?.metadata?.status ?? "",
            ).split("\n")[0].slice(0, 200);
          }
        }
        // The SAME request counted a third way: this customer, on this deployment. It is what
        // answers "how much of the Z.AI plan window did demo use", which is the question Jason
        // asked over the Alibaba screenshot and which neither of the other two groupings can
        // answer on its own.
        const pair = entry.byDeployment.get(deploymentId) ?? { id: deploymentId, alias: model, dollars: 0, requests: 0, tokens: 0 };
        pair.dollars += dollars;
        pair.requests += requests;
        pair.tokens += tokens;
        entry.byDeployment.set(deploymentId, pair);
      }
      const keys = [...byKey.values()].map((entry) => ({
        keyId: entry.keyId,
        alias: entry.alias,
        // Rounded to the cent-of-a-cent the panel prints. Summing floats over a month otherwise
        // shows a customer a number with fifteen decimal places in it.
        dollars: Math.round(entry.dollars * 1e6) / 1e6,
        requests: entry.requests,
        rows: entry.rows,
        tokens: entry.tokens,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        usage: [...entry.byUsage.values()].map((row) => ({
          provider: row.provider,
          model: row.model,
          deploymentId: row.deploymentId,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          calls: row.calls,
          cost: Math.round(row.cost * 1e6) / 1e6,
        })),
        deployments: [...entry.byDeployment.values()].map((row) => ({
          id: row.id,
          alias: row.alias,
          requests: row.requests,
          tokens: row.tokens,
          dollars: Math.round(row.dollars * 1e6) / 1e6,
        })),
        groups: [...entry.byGroup.values()]
          .sort((a, b) => (b.requests - a.requests) || a.group.localeCompare(b.group))
          .map((row) => ({ group: row.group, requests: row.requests })),
        models: [...entry.byModel.values()].map((row) => ({
          model: row.model,
          requests: row.requests,
          dollars: Math.round(row.dollars * 1e6) / 1e6,
        })),
      }));
      const deployments = [...byDeployment.values()].map((entry) => ({
        id: entry.id,
        alias: entry.alias,
        dollars: Math.round(entry.dollars * 1e6) / 1e6,
        requests: entry.requests,
        rows: entry.rows,
        tokens: entry.tokens,
        failures: entry.failures,
        lastFailureAt: entry.lastFailureAt,
        lastFailureWhy: entry.lastFailureWhy,
        // The five newest requests this deployment served INSIDE THIS WINDOW, newest first. The
        // window is on the answer as startDay and endDay, so a reader of this list always knows
        // what "recent" was measured over rather than having to assume it.
        recent: entry.recent.map((one) => ({ at: one.at, ok: one.ok === true })),
      }));
      return { ok: true, keys, deployments, startDay: from, endDay: to, recentKept: RECENT_REQUESTS };
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

    // ---- PROVIDERS-1: the management vocabulary ------------------------------------------------
    //
    // Every method below keeps this file's three rules: it never throws, it carries the same
    // deadline, and it writes no key anywhere. A provider key passes THROUGH addCredential and
    // patchCredential on its way to the proxy and is held by neither this object nor its caller.
    //
    // What is deliberately NOT here: /model/block and /model/unblock. Parking a key is done by
    // removing the deployments that reference it, which is a state this file can read back out of
    // /model/info; a blocked model is a flag that reads back as an ordinary row and would leave the
    // panel showing a pool that is bigger than the one actually serving.

    /**
     * Every deployment, whole. Not `models()` above, which answers a de-duplicated list of names
     * for the mint: this is one row per deployment with its model_info, which is what makes a pool
     * visible as a pool.
     */
    async listModels() {
      const answer = await call("GET", "/model/info");
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body?.data) ? answer.body.data : [];
      return { ok: true, rows: rows.map((row) => normalizeDeployment(row)) };
    },

    /** The aggregate per model_name, which is where max_input_tokens and supports_vision surface. */
    async modelGroups() {
      const answer = await call("GET", "/model_group/info");
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body?.data) ? answer.body.data : [];
      return {
        ok: true,
        groups: rows.map((row) => ({
          alias: String(row?.model_group ?? ""),
          contextWindow: numberOrNull(row?.max_input_tokens),
          supportsVision: row?.supports_vision === true,
          healthStatus: String(row?.health_status ?? ""),
          providers: Array.isArray(row?.providers) ? row.providers.map(String) : [],
        })),
      };
    },

    /**
     * One deployment, created.
     *
     * STRICTLY CREATE, and the id is ours. MEASURED ON THIS MAC 2026-09-08: POST /model/new with a
     * model_info.id that already exists answers 500 ("Failed to add model to db"), it does not
     * upsert. So a caller that retries a timed-out add without looking first makes a mess it cannot
     * see; addModel is create-only and cp/admin.mjs checks /model/info before any retry.
     */
    async addModel({ alias, vendorModel, credentialName = "", id = "", info = {}, params = {} }) {
      const body = {
        model_name: String(alias),
        litellm_params: {
          model: String(vendorModel),
          ...(credentialName ? { litellm_credential_name: String(credentialName) } : {}),
          ...params,
        },
        model_info: { ...(id ? { id: String(id) } : {}), ...info },
      };
      const answer = await call("POST", "/model/new", { body });
      if (!answer.ok) return withDbHint(answer);
      return { ok: true, id: String(answer.body?.model_id ?? id ?? ""), alias: String(answer.body?.model_name ?? alias) };
    },

    /**
     * The vendor model behind an alias, changed.
     *
     * MEASURED ON THIS MAC 2026-09-08: POST /model/update MERGES. It changed litellm_params.model
     * and left litellm_credential_name and every tb_* key exactly as they were, which is what makes
     * "a vendor retired a model" one call rather than a delete and a rebuild. It also REFUSES a
     * model_info-only edit with 400 "litellm_params not provided", which is why patchModel exists
     * below and why the two are not one function.
     */
    async updateModel({ id, alias = "", vendorModel = "", credentialName = "", params = {}, info = {} }) {
      const litellm = { ...params };
      if (vendorModel) litellm.model = String(vendorModel);
      if (credentialName) litellm.litellm_credential_name = String(credentialName);
      if (Object.keys(litellm).length === 0) {
        return { ok: false, why: "a vendor-model change needs a model to change to; a label or window edit is patchModel", configured: true };
      }
      const body = {
        ...(alias ? { model_name: String(alias) } : {}),
        litellm_params: litellm,
        model_info: { id: String(id), ...info },
      };
      const answer = await call("POST", "/model/update", { body });
      if (!answer.ok) return withDbHint(answer);
      return { ok: true, id: String(id) };
    },

    /** The label, the window, the visibility: a model_info-only edit, which only PATCH takes. */
    async patchModel({ id, info = {}, params = {} }) {
      const body = { model_info: { id: String(id), ...info } };
      if (Object.keys(params).length > 0) body.litellm_params = { ...params };
      const answer = await call("PATCH", `/model/${encodeURIComponent(String(id))}/update`, { body });
      if (!answer.ok) return withDbHint(answer);
      return { ok: true, id: String(id) };
    },

    async deleteModel(id) {
      const answer = await call("POST", "/model/delete", { body: { id: String(id) } });
      if (!answer.ok) return withDbHint(answer);
      return { ok: true, id: String(id) };
    },

    /**
     * The key pool, as the proxy stores it.
     *
     * MASKED ON READ, by the proxy itself: an api_key comes back as `sk****AA`. That mask is what
     * the panel renders, and it is never reconstructed on this side, because a mask this file
     * computed would be a mask this file could get wrong.
     */
    async listCredentials() {
      const answer = await call("GET", "/credentials");
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body?.credentials) ? answer.body.credentials : [];
      return { ok: true, rows: rows.map((row) => normalizeCredential(row)) };
    },

    async getCredential(name) {
      const answer = await call("GET", `/credentials/by_name/${encodeURIComponent(String(name))}`);
      if (!answer.ok) return answer;
      return { ok: true, credential: normalizeCredential(answer.body ?? {}) };
    },

    /** A key added. The VALUE goes in here and comes back out of nowhere. */
    async addCredential({ name, apiKey, baseUrl = "", info = {}, values = {} }) {
      const body = {
        credential_name: String(name),
        credential_values: {
          api_key: String(apiKey),
          ...(baseUrl ? { api_base: String(baseUrl) } : {}),
          ...values,
        },
        credential_info: { ...info },
      };
      const answer = await call("POST", "/credentials", { body });
      if (!answer.ok) return answer;
      return { ok: true, name: String(name) };
    },

    /**
     * A key rolled, in place, under a name that does not change.
     *
     * THIS IS THE ZERO-GAP ROLL and it is the whole reason the pool references a credential by name
     * rather than carrying the key on the deployment. The deployments are untouched, so the pool
     * never has a hole in it and no request can land between two states.
     *
     * MEASURED ON THIS MAC 2026-09-08: 0.033 s, and the read-back mask changed from the old value's
     * to the new one's. Also measured: PATCH answers 422 without `credential_name` IN THE BODY as
     * well as in the path, which the merged design did not have. Both are sent.
     */
    async patchCredential({ name, apiKey = "", baseUrl = "", info = null, values = {} }) {
      // ALL THREE FIELDS, ALWAYS. MEASURED ON THE R750 2026-09-08 against the running v1.100.0:
      // PATCH /credentials/{name} answers 422 "Field required" for credential_name AND for
      // credential_info, whichever one is missing, so a roll that sent only the value never landed
      // and the panel's zero-gap roll answered "the proxy answered 422" with nothing to act on.
      // credential_info is therefore read back off the credential and sent again unchanged when the
      // caller has nothing to say about it, because an empty object here would take tb_provider,
      // tb_key_label and tb_key_order off the slot and the panel would lose the pool it belongs to.
      const body = { credential_name: String(name) };
      const nextValues = { ...values };
      if (apiKey) nextValues.api_key = String(apiKey);
      if (baseUrl) nextValues.api_base = String(baseUrl);
      if (Object.keys(nextValues).length > 0) body.credential_values = nextValues;
      if (info !== null) body.credential_info = { ...info };
      else {
        const seen = await this.listCredentials();
        const row = seen.ok ? (seen.rows ?? []).find((one) => one.name === String(name)) : null;
        body.credential_info = row == null ? {} : {
          [TB.provider]: row.provider, [TB.keyLabel]: row.label, [TB.keyOrder]: row.order, tb_parked: row.parked,
        };
      }
      const answer = await call("PATCH", `/credentials/${encodeURIComponent(String(name))}`, { body });
      if (!answer.ok) return answer;
      return { ok: true, name: String(name) };
    },

    async deleteCredential(name) {
      const answer = await call("DELETE", `/credentials/${encodeURIComponent(String(name))}`);
      if (!answer.ok) return answer;
      return { ok: true, name: String(name) };
    },

    /**
     * The vision fallback map, one alias at a time.
     *
     * MEASURED ON THIS MAC 2026-09-08, and none of the three shapes matched what the merged design
     * assumed. GET /fallback with no model answers 405, so there is NO list-all and this is asked
     * per alias. POST takes {model, fallback_models} rather than {model_name, fallbacks}, and it
     * validates that the fallback model EXISTS, answering 400 with the available list -- so the
     * vision deployment has to be created before the fallback is set, which is an ordering the seed
     * keeps. POST on an alias that already has a row OVERWRITES it, which is what makes a repoint
     * one call. The delete needs fallback_type named in the query or it answers 404 while GET on
     * the same alias answers 200, which is the sort of half-answer that costs an afternoon.
     */
    async getFallback(alias) {
      const answer = await call("GET", `/fallback/${encodeURIComponent(String(alias))}`);
      if (!answer.ok) {
        // A model with no fallback is a 404 carrying a sentence, and it is a real answer rather
        // than a failure: it is what an alias with no vision route looks like.
        if (answer.status === 404) return { ok: true, alias: String(alias), fallbacks: [] };
        return answer;
      }
      return {
        ok: true,
        alias: String(alias),
        fallbacks: Array.isArray(answer.body?.fallback_models) ? answer.body.fallback_models.map(String) : [],
      };
    },

    async setFallback({ alias, fallbacks = [] }) {
      const answer = await call("POST", "/fallback", {
        body: { model: String(alias), fallback_models: fallbacks.map(String) },
      });
      if (!answer.ok) return answer;
      return { ok: true, alias: String(alias), fallbacks: fallbacks.map(String) };
    },

    async deleteFallback(alias) {
      const answer = await call("DELETE", `/fallback/${encodeURIComponent(String(alias))}`, {
        query: { fallback_type: "general" },
      });
      if (!answer.ok && answer.status !== 404) return answer;
      return { ok: true, alias: String(alias) };
    },

    /**
     * The pass-throughs, which is where PROXY-3's second TinyFish key goes and where a provider's
     * catalog is read from without this container ever holding the vendor key.
     *
     * THE PANEL MUST NEVER RENDER `headers`. MEASURED ON THIS MAC 2026-09-08: unlike /credentials,
     * which masks, GET /config/pass_through_endpoint answers with the header values IN THE CLEAR.
     * So this method drops them before anything above it can put one on a screen, and the raw shape
     * is not reachable from here at all.
     */
    listPassThrough,

    async addPassThrough({ path: pathname, target, headers = {}, includeSubpath = false, costPerRequest = null }) {
      const body = {
        path: String(pathname),
        target: String(target),
        headers: { ...headers },
        include_subpath: includeSubpath === true,
      };
      if (costPerRequest !== null) body.cost_per_request = Number(costPerRequest);
      const answer = await call("POST", "/config/pass_through_endpoint", { body });
      if (!answer.ok) return answer;
      return { ok: true, path: String(pathname) };
    },

    /**
     * One removed, BY ITS UUID.
     *
     * MEASURED ON THIS MAC 2026-09-08: endpoint_id is the row's uuid, not its path. Deleting by
     * path answers 400 "was not found in pass-through endpoint list" and leaves the row serving,
     * which is a removal that reports failure loudly enough but would have read as a missing
     * feature to anyone who did not look.
     */
    async deletePassThrough(id) {
      const answer = await call("DELETE", "/config/pass_through_endpoint", { query: { endpoint_id: String(id) } });
      if (!answer.ok) return answer;
      return { ok: true, id: String(id) };
    },

    // A vendor catalog used to be read THROUGH the proxy here, over a pass-through registered at
    // /catalog/<provider>. That method is gone with the pass-through: MEASURED ON THE R750
    // 2026-09-08, the pass-through stored the vendor key in the proxy's Postgres in CLEARTEXT and
    // handed it back unmasked to GET /config/pass_through_endpoint, which is a weaker place for a
    // key than the encrypted credentials table it was invented to avoid using. cp/admin.mjs reads
    // the vendor directly now, at the two moments the operator has just handed it the key, and
    // stores names only. deletePassThrough above is what takes the old doors down.

    /** One deployment asked whether it answers, right now. Used by the panel's health column. */
    async deploymentHealth(id) {
      const answer = await call("GET", "/health", { query: { model_id: String(id) } });
      // A 503 here is an ANSWER, not a failure to ask: it is what an unhealthy deployment looks
      // like, and the body carries which one and why. Treating it as an error would leave the panel
      // saying "not measured" for the exact case it exists to show.
      const body = answer.ok ? answer.body : null;
      if (!answer.ok && answer.status !== 503) return answer;
      const healthy = Array.isArray(body?.healthy_endpoints) ? body.healthy_endpoints.length : 0;
      const unhealthy = Array.isArray(body?.unhealthy_endpoints) ? body.unhealthy_endpoints.length : 0;
      return {
        ok: true,
        id: String(id),
        healthy: healthy > 0 && unhealthy === 0,
        why: unhealthy > 0 ? String(body?.unhealthy_endpoints?.[0]?.error ?? "the provider did not answer").split("\n")[0].slice(0, 300) : "",
      };
    },

    /** What the last health check said, per deployment, with no new call to any provider. */
    async healthLatest() {
      const answer = await call("GET", "/health/latest");
      if (!answer.ok) return answer;
      const latest = answer.body?.latest_health_checks ?? {};
      const rows = [];
      for (const [id, row] of Object.entries(latest)) {
        rows.push({
          id: String(id),
          alias: String(row?.model_name ?? ""),
          status: String(row?.status ?? ""),
          at: String(row?.checked_at ?? row?.created_at ?? ""),
          why: String(row?.error_message ?? row?.error ?? "").split("\n")[0].slice(0, 300),
        });
      }
      return { ok: true, rows };
    },

    /**
     * Whether a change made here will actually take.
     *
     * THERE IS NO ROUTE THAT ANSWERS THIS, and that is measured rather than assumed. MEASURED ON
     * THIS MAC 2026-09-08: GET /settings carries `alerting` and the callback lists, `values` is
     * empty, and `store_model_in_db` is not in it anywhere. So this is inferred, and it is honest
     * about the one case it cannot decide:
     *
     *   true   a row in /model/info carries model_info.db_model true. Proven.
     *   false  a deployment write came back with LiteLLM's own STORE_MODEL_IN_DB sentence. Proven
     *          the hard way, and recorded by whoever hit it.
     *   null   nothing is seeded yet, so a read cannot tell the two apart. The panel says so.
     *
     * This matters because the failure it guards against is the worst shape there is: with the flag
     * off, POST /credentials answers 200 and REALLY PERSISTS while POST /model/new answers 500. Half
     * a configuration, and green checkmarks on the half that did nothing.
     */
    async storeModelInDb() {
      const answer = await call("GET", "/model/info");
      if (!answer.ok) return { ok: false, on: null, why: answer.why };
      const rows = Array.isArray(answer.body?.data) ? answer.body.data : [];
      const any = rows.some((row) => row?.model_info?.db_model === true);
      if (any) {
        return { ok: true, on: true, why: "the proxy is serving at least one model out of its database, so a change made here takes effect on the next request" };
      }
      return {
        ok: true,
        on: null,
        why: "nothing has been added here yet, so this cannot be checked until the first change. This build has no route that reports the setting.",
      };
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
 * WHAT A TENANT'S KEY IS SCOPED TO, which is not the same list as what a customer is shown.
 *
 * These two were one array until this wave, and that is exactly how `plan-zai-vision` reached a
 * customer's Settings card: the vision route is a real model the key must be allowed to call, and
 * it is not a thing anybody buys. One function answers routing, the other answers what a person
 * reads, and nothing above this line uses one for the other.
 *
 * Every plan- alias the proxy serves, deduplicated, INCLUDING the ones no customer ever sees. A
 * pool is many deployments under one name, so the name is what a key is scoped to.
 */
export function servedPlanModels({ models = [], deployments = null } = {}) {
  const names = Array.isArray(deployments) && deployments.length > 0
    ? deployments.map((row) => String(row?.alias ?? ""))
    : models.map((id) => String(id ?? ""));
  return [...new Set(names.filter(isPlanModel))];
}

/**
 * The rows the registry hands the relay, built from the proxy's own deployments.
 *
 * PINNED. These field names are read by the relay (ui/) and asserted by tests/cp-relay-pair.
 * `id` EQUALS `model` on purpose, so there is one string rather than two that can drift: the
 * console's endpoint rows are keyed by id and the box's MODEL is the model, and making them the
 * same value removes a whole class of "the picker says one thing and the box runs another".
 *
 * THE ONE RULE THAT MAKES THIS WORTH SPLITTING OUT: a row with no customer label, or one marked not
 * customer-visible, is DROPPED. It is not rendered under its alias and it is not given a made-up
 * name. Until this wave the fallback was `${id} (included with your plan)`, and MEASURED ON THE
 * R750 2026-09-08 that put the literal string "plan-zai . 200k context" on demo's Settings card and
 * "Z.AI GLM (included with your plan) . plan-zai" on the always-visible agent context card. The
 * next mint would have handed every customer a "plan-zai-vision" card on top of it: a routing
 * target, described to a customer as something included with what they pay for.
 *
 * So an alias nobody has named is not a product, and the honest thing to do with it is not show it.
 * The panel is where a name is given, and the row appears the moment one is.
 *
 * `deployments` is the /model/info rows through normalizeDeployment, which is where the tb_ keys
 * are. `models` plus `windows` is the older name-only shape, kept because cp/provision.mjs still
 * calls it that way at mint; on that path PLAN_MODELS is the fallback register for the three ids
 * that already exist, and an id it does not know is dropped by the same rule.
 */
export function includedModelRows({ models = [], windows = {}, deployments = null } = {}) {
  if (Array.isArray(deployments)) {
    const byAlias = new Map();
    for (const row of deployments) {
      const id = String(row?.alias ?? "");
      if (!isPlanModel(id)) continue;
      // A pool is several deployments under one name. They carry the same customer-facing facts, so
      // the first one that is visible and named wins and the rest are the same row again.
      if (byAlias.has(id)) continue;
      const known = PLAN_MODELS[id] ?? null;
      const label = String(row?.customerLabel ?? "") || known?.modelLabel || "";
      const name = String(row?.customerName ?? "") || known?.name || "";
      // TWO CASES, and keeping them apart is what makes this safe to ship before the seed runs.
      //
      // A row SOMEBODY HAS NAMED is judged on what they said: it appears only if it is marked
      // visible and carries both the words on the card and the name the Titan says. An unnamed row
      // is dropped even when it is marked visible, because a card with no words on it is worse than
      // no card.
      //
      // A row NOBODY HAS EVER NAMED is a deployment the proxy read out of its config file, which on
      // the R750 is every deployment until the seed runs. PLAN_MODELS answers for the three ids
      // that already exist and nothing answers for anything else, so plan-zai keeps its card
      // through the upgrade and plan-zai-vision -- a routing target that is in no register -- never
      // gets one.
      if (row?.named === true) {
        if (row?.customerVisible !== true || label.length === 0 || name.length === 0) continue;
      } else if (known == null) {
        continue;
      }
      byAlias.set(id, {
        id,
        model: id,
        name,
        contextWindow: numberOrNull(row?.contextWindow) ?? numberOrNull(windows?.[id]) ?? known?.contextWindow ?? null,
        servedBy: String(row?.servedBy ?? "") || known?.servedBy || id,
        modelLabel: label,
      });
    }
    return [...byAlias.values()];
  }
  const rows = [];
  for (const id of models.filter(isPlanModel)) {
    const known = PLAN_MODELS[id] ?? null;
    // No entry here and no tb_ metadata to read means nobody has ever said what this is. Dropped,
    // for the same reason as above.
    if (known == null) continue;
    rows.push({
      id,
      model: id,
      name: known.name,
      contextWindow: numberOrNull(windows?.[id]) ?? known.contextWindow ?? null,
      servedBy: known.servedBy,
      modelLabel: known.modelLabel,
    });
  }
  return rows;
}
