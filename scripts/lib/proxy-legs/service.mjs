// The service leg of scripts/verify-proxy.mjs: the proxy itself, before any tenant exists (PROXY-1).
//
// Six things, in the order a failure in one explains the next:
//   1. readiness    /health/readiness answers with no credential at all
//   2. the door     no key is 401, a wrong key is 401, and only the master key opens /key/generate
//   3. a model      a minted virtual key reaches a model and gets an answer
//   4. the pool     with one Z.AI subscription down, the same request is served by the other one
//   5. the config   a change to config.yaml in the DIRECTORY bind is picked up with no restart
//   6. no leak      no response body in the whole run carries any provider key
//
// Legs 1 to 5 run against the stub by default, which is our code and the shape of the real one, in
// seconds. `--real` runs the identical legs against a pulled image; the gate says which it ran.
//
// The seventh thing this file checks needs no server at all: the config an operator actually ships
// says what the design decided. Model names are a contract with every box pointed at them, and the
// two cache numbers are what "revocation within a minute" and "the panel sees a number" rest on.
//
// ---- WHAT CHANGED AT PROVIDERS-1 -----------------------------------------------------------------
// The shipped config.yaml no longer holds a model list, a fallback map or a global door list: all
// three moved into the proxy's own database and are managed from the Providers panel. So the file
// assertions below now come in two halves -- what config.yaml must NO LONGER say, and what
// config.stage1.yaml (the form the fleet is carried across the first restart on, and the last one
// anybody edits by hand) must still say.
//
// The SERVER legs run against a stub configured from config.stage1.yaml, and that is deliberate:
// they are about the proxy's door, its pool and its pass-through, which stage one is the last file
// to express. The same shapes coming out of the DATABASE are the providers leg's job, and it proves
// them from /model/new and /credentials rather than from a file.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { call, fingerprint, repoRoot, secret } from "./harness.mjs";
import { blockParentOf, createStubProxy, createStubUpstream, readGeneralSettings, readModelList, readNestedList } from "./stub-proxy.mjs";

const CONFIG_PATH = path.join(repoRoot, "deploy/coolify/proxy-config/config.yaml");
const STAGE1_PATH = path.join(repoRoot, "deploy/coolify/proxy-config/config.stage1.yaml");
const COMPOSE_PATH = path.join(repoRoot, "deploy/coolify/proxy.compose.yml");

// The names of the two Z.AI subscriptions, which is what a pool is: one model_name, two keys.
const ZAI_1 = "PROXY_ZAI_KEY_1";
const ZAI_2 = "PROXY_ZAI_KEY_2";

export async function run({ report, real, baseUrl, masterKey }) {
  const { step, check, unresolved, note } = report;

  // ---- the file, with no server involved --------------------------------------------------------
  step("the config an operator ships");
  const configText = readFileSync(CONFIG_PATH, "utf8");
  const stage1Text = readFileSync(STAGE1_PATH, "utf8");
  const models = readModelList(stage1Text);
  const names = [...new Set(models.map((one) => one.model_name))];

  // What config.yaml must NO LONGER say. Each of these is a thing that moved into the database at
  // PROVIDERS-1, and a file that still declares one is a file that will quietly win over the panel.
  check(readModelList(configText).length === 0,
    "config.yaml declares NO model_list: the deployments live in the proxy's database and are managed from the panel",
    `${readModelList(configText).length} model entries in the shipped file`);
  check(!/^\s{2}fallbacks:/m.test(configText),
    "and no router_settings.fallbacks, because the vision fallback is a database row the panel can require");
  check(readNestedList(configText, "allowed_routes").length === 0,
    "and no allowed_routes: the global door list is gone and the boundary is each key's own list",
    `${readNestedList(configText, "allowed_routes").length} route(s) still listed`);

  // What config.stage1.yaml must still say: it is what carries the fleet across the first restart,
  // and the pool shape it expresses is the one `proxy seed` reproduces in the database.
  check(names.includes("plan-zai"), "config.stage1.yaml still serves plan-zai across the first restart", names.join(", "));
  check(models.filter((one) => one.model_name === "plan-zai").length === 2,
    "plan-zai is TWO entries, which is how a pooled subscription is spelled",
    `${models.filter((one) => one.model_name === "plan-zai").length} entries`);
  const zaiKeys = new Set(models.filter((one) => one.model_name === "plan-zai").map((one) => one.api_key_env));
  check(zaiKeys.size === 2 && zaiKeys.has(ZAI_1) && zaiKeys.has(ZAI_2),
    "and the two entries carry two different keys, so a dead subscription drains to the other",
    [...zaiKeys].join(", "));
  check(names.includes("plan-minimax"), "config.stage1.yaml serves plan-minimax");
  check(names.every((one) => one.startsWith("plan-")),
    "every model name is plan- prefixed, so an included row can never collide with a customer's own endpoint id",
    names.join(", "));

  // No key in either file. This is why they can live in git and sit readable in the bind mount, and
  // it is the difference between this design and the box-secrets.json copies it replaces.
  const literalKeys = models.filter((one) => one.api_key_env === "" );
  check(literalKeys.length === 0,
    "no model carries a literal key: every credential is an os.environ reference",
    literalKeys.map((one) => one.model_name).join(", ") || "none");

  for (const [label, text] of [["config.yaml", configText], ["config.stage1.yaml", stage1Text]]) {
    const settings = readGeneralSettings(text);
    check(settings.user_api_key_cache_ttl === 30,
      `${label}: user_api_key_cache_ttl is set EXPLICITLY, so revocation is measurable rather than lucky`,
      `= ${settings.user_api_key_cache_ttl} (the default is 60 and is what a missing line would give)`);
    check(settings.proxy_batch_write_at === 10,
      `${label}: proxy_batch_write_at is 10, so the panel and this gate see a spend number promptly`,
      `= ${settings.proxy_batch_write_at}`);
    check(settings.store_model_in_db === true,
      `${label}: store_model_in_db is TRUE, which is the line PROVIDERS-1 turns on`,
      `= ${settings.store_model_in_db}`);
    check(settings.proxy_config_reload_interval_seconds === 10,
      `${label}: the reload interval is pinned, so a future second worker is bounded rather than a surprise`,
      `= ${settings.proxy_config_reload_interval_seconds}`);
    // NOT set, deliberately: it would stop a FAILED request being written to the spend log at all,
    // and "zero failed requests during the roll" would then be true because nothing could ever be
    // written. A gate that cannot fail is not a gate.
    check(settings.disable_error_logs === undefined,
      `${label}: disable_error_logs is NOT set, so a failed request is still written and can still be counted`,
      settings.disable_error_logs === undefined ? "absent" : `= ${settings.disable_error_logs}`);
  }

  // WHERE A BLOCK SITS, which is a thing this file got wrong once and nothing caught.
  //
  // MEASURED ON THE R750 2026-09-08: the two pass_through_endpoints entries were at the TOP LEVEL
  // of config.yaml. LiteLLM reads that key from general_settings and nowhere else, so the proxy
  // started clean, logged nothing, listed no /tinyfish path in its own openapi.json and answered
  // `404 {"detail":"Not Found"}` on every call to one -- while docs/PROXY.md carried a measured
  // table for the route. mcp_servers is the opposite and is read from the top level. Both are
  // asserted, because either one in the other's place is silence rather than an error.
  for (const [label, text] of [["config.yaml", configText], ["config.stage1.yaml", stage1Text]]) {
    check(blockParentOf(text, "pass_through_endpoints") === "general_settings",
      `${label}: pass_through_endpoints is under general_settings, which is the only place LiteLLM reads it`,
      `found under ${blockParentOf(text, "pass_through_endpoints") ?? "nothing"}`);
    check(blockParentOf(text, "mcp_servers") === "(top level)",
      `${label}: and mcp_servers is at the top level, which is the only place LiteLLM reads THAT`,
      `found under ${blockParentOf(text, "mcp_servers") ?? "nothing"}`);
  }

  // THE DOOR LIST IS GONE FROM BOTH FILES, and the paragraph that replaced it has to still be there.
  // A list that came back would refuse the two path-parameter routes the panel is built on (PATCH
  // /credentials/{name} and PATCH /model/{id}/update) with a 403 and no other clue, and it would
  // refuse the master key while it did it.
  for (const [label, text] of [["config.yaml", configText], ["config.stage1.yaml", stage1Text]]) {
    check(readNestedList(text, "allowed_routes").length === 0,
      `${label}: carries no allowed_routes list at all`,
      `${readNestedList(text, "allowed_routes").length} route(s)`);
    check(/allowed_routes/.test(text),
      `${label}: and says in words what the list did and what replaced it, so nobody adds it back by reflex`);
  }

  // The compose, for the one property that is the whole security shape. Comment lines are stripped
  // first: the header explains at length WHY there is no port and no Domain, and a check that read
  // the explanation as the thing it forbids would be a check that can only ever fail.
  const composeText = readFileSync(COMPOSE_PATH, "utf8");
  const composeCode = composeText.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  check(!/^\s*ports:/m.test(composeCode),
    "the compose publishes no port, so a box reaches the proxy only through the one nftables accept");
  check(!/^\s*Domain/mi.test(composeCode) && !/traefik/i.test(composeCode),
    "and sets no Domain and no traefik label, so Traefik routes nothing to it");

  // ---- the server -------------------------------------------------------------------------------
  if (real) {
    if (!baseUrl || !masterKey) {
      unresolved("the legs against a real proxy", "--real needs --url and --master-key, and neither was given");
      return;
    }
    step(`the real proxy at ${baseUrl}`);
    note("the same legs, against the pulled image rather than the stub");
    await serverLegs({ report, base: baseUrl, masterKey, stub: null, upstreams: null, configFile: null });
    return;
  }

  step("the stub proxy");
  note("the real image is a gigabyte and does not fit a 300 second gate, so the default proves OUR");
  note("code against a stand-in that speaks the same routes. --real runs these same legs for real.");

  // A temp DIRECTORY holding a copy of the real config, because that is what the deploy binds: a
  // directory, never the file, so a change can be made without the container being recreated.
  //
  // config.STAGE1 is what is copied, and that is the whole point rather than a convenience: these
  // server legs are about the door, the pool and the pass-through, and stage one is the last file
  // that expresses them. The shipped config.yaml has no model_list at all, because after the second
  // restart the deployments come out of the proxy's database. The providers leg proves the same
  // shapes from there, through /model/new and /credentials.
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-config-"));
  const configFile = path.join(dir, "config.yaml");
  cpSync(STAGE1_PATH, configFile);

  const zai1 = createStubUpstream({ name: ZAI_1, content: "answered by the first subscription" });
  const zai2 = createStubUpstream({ name: ZAI_2, content: "answered by the second subscription" });
  const minimax = createStubUpstream({ name: "PROXY_MINIMAX_KEY", content: "answered by minimax" });
  const upstreams = {
    [ZAI_1]: await zai1.listen(),
    [ZAI_2]: await zai2.listen(),
    PROXY_MINIMAX_KEY: await minimax.listen(),
  };

  // The keys this run pretends the operator holds. Registered with the harness so every response
  // body in the whole run is checked for them, which is the leak leg.
  const fakeZai1 = secret(ZAI_1, "zai-first-subscription-0123456789abcdef");
  secret(ZAI_2, "zai-second-subscription-0123456789abcdef");
  secret("PROXY_MINIMAX_KEY", "minimax-subscription-0123456789abcdef");
  const stubMaster = secret("PROXY_MASTER_KEY", "sk-stub-master-0123456789abcdef0123456789ab");
  note(`the operator key this run watches for: ${ZAI_1}, ${fingerprint(fakeZai1)}`);

  const stub = createStubProxy({ configPath: configFile, masterKey: stubMaster, upstreams, cacheTtlMs: 0 });
  const base = await stub.listen();

  try {
    await serverLegs({ report, base, masterKey: stubMaster, stub, upstreams: { zai1, zai2 }, configFile });
  } finally {
    await stub.close();
    await zai1.close();
    await zai2.close();
    await minimax.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function serverLegs({ report, base, masterKey, stub, upstreams, configFile }) {
  const { step, check, unresolved } = report;

  step("readiness");
  const ready = await call(`${base}/health/readiness`);
  check(ready.status === 200, "GET /health/readiness answers with no credential at all",
    `status ${ready.status}${ready.error ? ` (${ready.error})` : ""}`);

  step("the door");
  const noKey = await call(`${base}/v1/models`);
  check(noKey.status === 401, "a request with no key is refused", `status ${noKey.status}`);
  const wrongKey = await call(`${base}/v1/models`, { token: "sk-not-a-key-at-all-000000" });
  check(wrongKey.status === 401, "and so is a key nobody minted", `status ${wrongKey.status}`);

  const minted = await call(`${base}/key/generate`, {
    method: "POST",
    token: masterKey,
    body: {
      key_alias: `titanbot-gate-${Date.now()}`,
      models: ["plan-zai", "plan-minimax"],
      // NO `tags`. MEASURED on this Mac 2026-09-08 against a real v1.100.0: a mint carrying tags is
      // refused 403 "only available for LiteLLM Enterprise users: tags", so this gate could never
      // have minted a key against the image it is written for. docs/PROXY.md said so already; the
      // stub used to accept them, which is what hid it. The tenant rides key_alias and metadata,
      // which is where cp/proxy.mjs and the admin console read it from anyway.
      metadata: { slug: "gate", box: "none" },
      rpm_limit: 60,
      soft_budget: 5,
    },
  });
  if (!check(minted.status === 200 && typeof minted.json?.key === "string",
    "the master key mints a virtual key", `status ${minted.status}`)) {
    unresolved("everything below", "there is no virtual key to run it with");
    return;
  }
  const tenantKey = minted.json.key;

  const mintedByTenant = await call(`${base}/key/generate`, {
    method: "POST", token: tenantKey, body: { key_alias: "a key minting a key" },
  });
  check(mintedByTenant.status === 401,
    "and a virtual key cannot mint another one, so a customer's own agents cannot widen their plan",
    `status ${mintedByTenant.status}`);

  // THE PASS-THROUGH ROUTE EXISTS, asked of the PROXY rather than of the file.
  //
  // The config check above proves the block is in the right place in the tree we ship. This proves
  // the running server actually registered the route, which is the thing that was false on the
  // R750 for the whole of the first wave. A 404 here means the route is not served; anything else,
  // including an upstream refusal because no TinyFish key is set, means it is.
  step("the pass-through is a route this proxy serves");
  const passThrough = await call(`${base}/tinyfish/search?query=gate`, { token: tenantKey });
  check(passThrough.status !== 404,
    "GET /tinyfish/search is registered (a 404 means the config block is in the wrong place)",
    `status ${passThrough.status}`);

  step("a model");
  const models = await call(`${base}/v1/models`, { token: tenantKey });
  const served = (models.json?.data ?? []).map((one) => one.id);
  check(models.status === 200 && served.includes("plan-zai"),
    "the virtual key sees the models its plan includes", served.join(", "));

  const answer = await call(`${base}/v1/chat/completions`, {
    method: "POST",
    token: tenantKey,
    body: { model: "plan-zai", messages: [{ role: "user", content: "say ok" }] },
  });
  check(answer.status === 200 && Array.isArray(answer.json?.choices),
    "and reaches plan-zai through the proxy", `status ${answer.status}`);

  const wrongModel = await call(`${base}/v1/chat/completions`, {
    method: "POST", token: tenantKey, body: { model: "plan-not-a-model", messages: [] },
  });
  check(wrongModel.status === 400,
    "a model that is not in the list is refused rather than forwarded", `status ${wrongModel.status}`);

  step("the two-key pool");
  if (!upstreams) {
    unresolved("the pool drains to its second subscription",
      "taking one of the operator's real subscriptions down is not something a gate may do; run this leg against the stub");
  } else {
    // Both up: over enough tries, both should answer, which is what simple-shuffle means.
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const one = await call(`${base}/v1/chat/completions`, {
        method: "POST", token: tenantKey, body: { model: "plan-zai", messages: [] },
      });
      if (one.json?.served_by) seen.add(one.json.served_by);
    }
    check(seen.size === 2, "with both subscriptions up, both of them answer", [...seen].join(", "));

    // And with one down, every request still gets an answer, from the other one.
    upstreams.zai1.state.healthy = false;
    const drained = new Set();
    let refused = 0;
    for (let i = 0; i < 8; i += 1) {
      const one = await call(`${base}/v1/chat/completions`, {
        method: "POST", token: tenantKey, body: { model: "plan-zai", messages: [] },
      });
      if (one.status !== 200) refused += 1;
      else if (one.json?.served_by) drained.add(one.json.served_by);
    }
    check(refused === 0 && drained.size === 1 && drained.has(ZAI_2),
      "with the first subscription down, every request is still answered by the second",
      `${refused} refused, served by ${[...drained].join(", ") || "nobody"}`);
    upstreams.zai1.state.healthy = true;
  }

  step("the config in the directory bind");
  if (!configFile || !stub) {
    unresolved("a config change is read without a recreate",
      "against a real proxy this is measured on the R750, by editing /data/titanbot-proxy/config/config.yaml");
  } else {
    const before = stub.modelNames();
    const text = readFileSync(configFile, "utf8");
    // A fourth model name, appended the way an operator adding a subscription would.
    writeFileSync(configFile, text.replace(
      /^model_list:$/m,
      "model_list:\n  - model_name: plan-gate-probe\n    litellm_params:\n      model: openai/probe\n      api_key: os.environ/PROXY_ZAI_KEY_1\n",
    ));
    const after = await call(`${base}/v1/models`, { token: masterKey });
    const now = (after.json?.data ?? []).map((one) => one.id);
    check(now.includes("plan-gate-probe") && !before.includes("plan-gate-probe"),
      "a model added to config.yaml in the bind is served with no restart and no recreate",
      `before ${before.length} models, now ${now.length}`);
    writeFileSync(configFile, text);
  }

  step("revoking it");
  const revoked = await call(`${base}/key/delete`, {
    method: "POST", token: masterKey, body: { key_aliases: [minted.json.key_alias] },
  });
  check(revoked.status === 200, "the master key revokes by alias, which is what the control plane derives",
    `status ${revoked.status}`);
  const afterRevoke = await call(`${base}/v1/chat/completions`, {
    method: "POST", token: tenantKey, body: { model: "plan-zai", messages: [] },
  });
  // Measured as the PROXY refusing the key, never as the relay having stopped serving it: the
  // registry deliberately keeps its last good answer, so a relay that has gone quiet proves nothing.
  check(afterRevoke.status === 401, "and the proxy then refuses that key", `status ${afterRevoke.status}`);
}
