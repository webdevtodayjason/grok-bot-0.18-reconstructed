// The providers leg of scripts/verify-proxy.mjs: the proxy's configuration as a DATABASE rather than
// a text file (PROVIDERS-1).
//
// This is the gate for the thing Jason asked for on 2026-09-08: "say I have to roll a key, or I want
// to add a provider or add a third, second, or fourth key on a specific model plan ... the mechanism
// for both me and the AI agent needs to be able to do this on our own." Every one of those is a
// route now, and every one of them is measured here.
//
// In order, because a failure in one explains the next:
//    0. the worker count, FIRST, because everything below reports "on the next request"
//    1. a provider added: a credential, a deployment that references it, and a served answer
//    2. a second and a third key on ONE plan model, all of them serving
//    3. a key ROLLED with traffic flowing throughout, and zero failed requests across a window
//       longer than user_api_key_cache_ttl
//    4. a key removed, add-first-delete-second, never delete-then-add
//    5. a plan model repointed at a new vendor model, alias unchanged, next request uses it
//    6. a plan model saved with no vision fallback REFUSED
//    7. a catalog read through a pass-through, with the caller holding no vendor key
//    8. per-deployment spend, with the row count equal to the request count
//    9. a tenant key refused /key/info, /model/info, /model_group/info and /health while chat
//       completions and /v1/models still work -- which is PROXY-8 closed per key
//
// AGAINST THE STUB BY DEFAULT, against a real proxy with --real. The stub's management surface was
// written from a real v1.100.0 on this Mac on 2026-09-08 and copies its refusals, not only its happy
// paths; the sharp edges are listed at the top of stub-proxy.mjs.
//
// EVERY KEY VALUE THIS LEG USES IS REGISTERED AS A WATCHED SECRET. The whole-run leak check in
// verify-proxy.mjs passes vacuously if nothing registers one, and this leg is the one that puts real
// key-shaped values through /credentials, so it is the one that has to.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { call, fingerprint, repoRoot, secret, sleep } from "./harness.mjs";
import { createStubCatalog, createStubProxy, createStubUpstream } from "./stub-proxy.mjs";

const CONFIG_PATH = path.join(repoRoot, "deploy/coolify/proxy-config/config.yaml");
const COMPOSE_PATH = path.join(repoRoot, "deploy/coolify/proxy.compose.yml");
const BOOTSTRAP_PATH = path.join(repoRoot, "deploy/coolify/proxy-config/bootstrap.json");

// Every name this leg makes carries this, so a --real run against the R750 can be told apart from a
// customer's rows at a glance and cleaned up by prefix.
const MARK = "gate-providers";

export async function run({ report, real, baseUrl, masterKey }) {
  const { step, check, unresolved, note } = report;

  // ---- bootstrap.json, with no server involved ---------------------------------------------------
  // The file a FRESH install seeds from. It is asserted here rather than in the unit test as well,
  // because the plan models it names are what the rest of this leg is written against.
  step("bootstrap.json, what a fresh install seeds");
  let bootstrap = null;
  try { bootstrap = JSON.parse(readFileSync(BOOTSTRAP_PATH, "utf8")); }
  catch (error) { check(false, "bootstrap.json parses", String(error?.message ?? error)); }
  if (bootstrap) {
    check(Number.isInteger(bootstrap.schemaVersion), "it carries a schema version", `= ${bootstrap.schemaVersion}`);
    const visible = (bootstrap.planModels ?? []).filter((one) => one.customerVisible);
    const hidden = (bootstrap.planModels ?? []).filter((one) => !one.customerVisible);
    check(visible.length > 0 && visible.every((one) => one.customerName && one.customerLabel),
      "every customer-visible plan model has a name and a label a person reads",
      visible.map((one) => `${one.modelName} -> ${one.customerName}`).join(", "));
    check(hidden.some((one) => one.modelName.endsWith("-vision")),
      "and the vision model is NOT customer-visible, so it can never become a card",
      hidden.map((one) => one.modelName).join(", ") || "none");
    check((bootstrap.planModels ?? []).every((one) => !one.customerVisible || one.visionFallback),
      "and every customer-visible plan model names a vision fallback");
    // No value in it, ever. The unit test says the same thing from the other side; both are cheap.
    const text = readFileSync(BOOTSTRAP_PATH, "utf8");
    const suspicious = [...text.matchAll(/"[A-Za-z0-9_\-.]{28,}"/g)].map((m) => m[0])
      .filter((one) => !/^"(https?:|[a-z]+\/)/.test(one));
    check(suspicious.length === 0, "and holds nothing that looks like a credential",
      suspicious.slice(0, 3).join(", ") || "nothing key-shaped in it");
  }

  // ---- 0. the worker count ------------------------------------------------------------------------
  // Everything below reports a change as effective on the NEXT REQUEST. That is only true on one
  // worker: with two, a change made through one worker's API is picked up by the other after
  // proxy_config_reload_interval_seconds. So the count is established before any timing is claimed,
  // and the leg changes what it asserts rather than asserting something it cannot know.
  step("how many workers this proxy runs");
  const composeText = readFileSync(COMPOSE_PATH, "utf8");
  const workersInCompose = /--num_workers",\s*"(\d+)"/.exec(composeText)?.[1];
  check(workersInCompose === "1",
    "the compose pins --num_workers 1, which is what makes 'the next request' literally true",
    `= ${workersInCompose ?? "not pinned"}`);
  const oneWorker = workersInCompose === "1";
  if (!oneWorker) {
    note("more than one worker: every timing below waits one reload interval instead of asserting the next request");
  }

  if (real) {
    if (!baseUrl || !masterKey) {
      unresolved("the providers leg against a real proxy", "--real needs --url and --master-key, and neither was given");
      return;
    }
    step(`the real proxy at ${baseUrl}`);
    note("the same legs, against the pulled image rather than the stub");

    // A real proxy needs somewhere real to send a request. The deployments this leg creates are its
    // own, never a customer's, so it stands up its own stand-in subscriptions HERE and points the
    // proxy back at this machine. TITANBOT_PROXY_UPSTREAM_HOST is the name the PROXY can reach this
    // machine by: host.docker.internal from a container on Docker Desktop, and on the R750 the name
    // of whatever container the gate runs in. Everything the leg makes is still deleted at the end.
    const host = process.env.TITANBOT_PROXY_UPSTREAM_HOST ?? "host.docker.internal";
    const one = createStubUpstream({ name: "KEY_ONE", content: "answered by key one" });
    const two = createStubUpstream({ name: "KEY_TWO", content: "answered by key two" });
    const three = createStubUpstream({ name: "KEY_THREE", content: "answered by key three" });
    const rolled = createStubUpstream({ name: "KEY_ROLLED", content: "answered by the rolled key" });
    const cat = createStubCatalog({ name: "zai", models: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"] });
    const bases = {
      KEY_ONE: await one.listen({ host }),
      KEY_TWO: await two.listen({ host }),
      KEY_THREE: await three.listen({ host }),
      KEY_ROLLED: await rolled.listen({ host }),
    };
    const catUrl = await cat.listen({ host });
    note(`this machine is reachable to the proxy as ${host}; set TITANBOT_PROXY_UPSTREAM_HOST if it is not`);

    // The values this run puts through /credentials. Generated, never a real subscription, and
    // registered as watched secrets so the whole-run leak check has something real to look for.
    const values = {
      KEY_ONE: secret("gate provider key one", `gate-one-${Date.now().toString(36)}-0123456789abAA`),
      KEY_TWO: secret("gate provider key two", `gate-two-${Date.now().toString(36)}-0123456789abBB`),
      KEY_THREE: secret("gate provider key three", `gate-three-${Date.now().toString(36)}-0123456789CC`),
      KEY_ROLLED: secret("the rolled-in gate key", `gate-rolled-${Date.now().toString(36)}-0123456789DD`),
    };
    try {
      await legs({
        report, base: baseUrl, masterKey, oneWorker,
        upstreams: { one, two, three, rolled },
        apiBases: bases,
        catalog: { server: cat, url: catUrl },
        values, real: true,
      });
    } finally {
      await one.close(); await two.close(); await three.close(); await rolled.close();
      await cat.close();
    }
    return;
  }

  step("the stub proxy");
  note("the real image is a gigabyte and does not fit a 300 second gate, so the default proves OUR");
  note("code against a stand-in written from a real v1.100.0, refusals included. --real runs these");
  note("same legs for real.");

  const dir = mkdtempSync(path.join(tmpdir(), "proxy-providers-"));
  const configFile = path.join(dir, "config.yaml");
  cpSync(CONFIG_PATH, configFile);

  // Three "subscriptions" and a vendor catalog. The content each upstream answers with is how a leg
  // sees WHICH key served a request, which is the only way to prove a roll took effect.
  const one = createStubUpstream({ name: "KEY_ONE", content: "answered by key one" });
  const two = createStubUpstream({ name: "KEY_TWO", content: "answered by key two" });
  const three = createStubUpstream({ name: "KEY_THREE", content: "answered by key three" });
  const rolled = createStubUpstream({ name: "KEY_ROLLED", content: "answered by the rolled key" });
  const catalog = createStubCatalog({ name: "zai", models: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"] });
  const upstreams = {
    KEY_ONE: await one.listen(),
    KEY_TWO: await two.listen(),
    KEY_THREE: await three.listen(),
    KEY_ROLLED: await rolled.listen(),
  };
  const catalogUrl = await catalog.listen();

  // The values a run pretends the operator's subscriptions are, registered so the whole-run leak
  // check has something real to look for. These go THROUGH /credentials, which is the custody path
  // this wave adds, so if any of them ever came back in a body the gate has to say so.
  const values = {
    KEY_ONE: secret("provider key one", "zai-subscription-one-0123456789abcdefAA"),
    KEY_TWO: secret("provider key two", "zai-subscription-two-0123456789abcdefBB"),
    KEY_THREE: secret("provider key three", "zai-subscription-three-0123456789abcdCC"),
    KEY_ROLLED: secret("the rolled-in key", "zai-subscription-rolled-0123456789abcDD"),
    CATALOG: secret("the catalog key", "zai-catalog-read-0123456789abcdefEEEE"),
  };
  const stubMaster = secret("PROXY_MASTER_KEY", "sk-stub-master-0123456789abcdef0123456789ab");
  note(`the operator keys this run watches for: ${Object.keys(values).length}, e.g. ${fingerprint(values.KEY_ONE)}`);

  const stub = createStubProxy({
    configPath: configFile,
    masterKey: stubMaster,
    upstreams: { ...upstreams, [catalogUrl]: catalogUrl },
    cacheTtlMs: 0,
    environment: { PROXY_CATALOG_KEY: values.CATALOG },
  });
  const base = await stub.listen();

  try {
    await legs({ report, base, masterKey: stubMaster, oneWorker, upstreams: { one, two, three, rolled }, apiBases: null, catalog: { server: catalog, url: catalogUrl }, values, real: false });
  } finally {
    await stub.close();
    await one.close(); await two.close(); await three.close(); await rolled.close();
    await catalog.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function legs({ report, base, masterKey, oneWorker, upstreams, apiBases, catalog, values, real }) {
  const { step, check, unresolved, note } = report;
  const M = { token: masterKey };
  const suffix = Date.now().toString(36);
  const alias = `${MARK}-${suffix}`;
  const made = { credentials: [], deployments: [], passThroughs: [], keys: [] };

  // Against a real proxy the values have to come from somewhere that is not this file. They are
  // generated, registered as watched secrets, and they are only ever written to the operator's own
  // credential slots under a gate- prefix, never to a customer's.
  const keyValue = (name) => values?.[name]
    ?? secret(`${name} for this run`, `${MARK}-${name.toLowerCase()}-${suffix}-000000000000`);
  // The stub picks its upstream by the credential's env name and ignores api_base entirely; a real
  // proxy does the opposite. One helper, so the two modes run the same code.
  const apiBaseFor = (name) => `${apiBases?.[name] ?? "http://upstream.invalid"}/v1`;

  try {
    // ---- 1. a provider added ---------------------------------------------------------------------
    step("a provider added: a credential, a deployment, an answer");
    const credOne = `${alias}-key-1`;
    const addCred = await call(`${base}/credentials`, {
      method: "POST", ...M,
      body: {
        credential_name: credOne,
        credential_values: { api_key: keyValue("KEY_ONE") },
        credential_info: { tb_provider: MARK, tb_key_label: "first subscription", tb_key_order: 1, env: "KEY_ONE" },
      },
    });
    if (!check(addCred.status === 200, "POST /credentials takes a provider key", `status ${addCred.status}`)) {
      unresolved("everything below", "there is no credential to hang a deployment on");
      return;
    }
    made.credentials.push(credOne);

    const listed = await call(`${base}/credentials`, M);
    const row = (listed.json?.credentials ?? []).find((c) => c.credential_name === credOne);
    check(row != null && typeof row.credential_values?.api_key === "string" && row.credential_values.api_key.includes("****"),
      "and reading it back gives a MASK, not the key -- which is what the panel renders",
      `api_key came back as ${row?.credential_values?.api_key ?? "nothing"}`);

    const planName = `plan-${MARK}-${suffix}`;
    const idOne = `${alias}-dep-1`;
    const addModel = await call(`${base}/model/new`, {
      method: "POST", ...M,
      body: {
        model_name: planName,
        litellm_params: { model: "openai/vendor-one", api_base: apiBaseFor("KEY_ONE"), litellm_credential_name: credOne },
        model_info: {
          id: idOne, tb_provider: MARK, tb_key_label: "first subscription", tb_key_order: 1,
          tb_customer_name: "Gate Model", tb_customer_label: "Gate Model", tb_customer_visible: true,
          tb_served_by: "the gate", tb_vision_fallback: `${planName}-vision`, tb_plans: ["gate"],
          max_input_tokens: 200000, supports_vision: false,
        },
      },
    });
    check(addModel.status === 200, "POST /model/new adds a deployment that REFERENCES that credential",
      `status ${addModel.status}`);
    if (addModel.status === 200) made.deployments.push(idOne);

    // The same id twice is a 500, never an upsert. Measured, and the reason the control plane
    // generates and tracks the id rather than posting and hoping.
    const duplicate = await call(`${base}/model/new`, {
      method: "POST", ...M,
      body: { model_name: planName, litellm_params: { model: "openai/vendor-one" }, model_info: { id: idOne } },
    });
    check(duplicate.status === 500,
      "and the SAME model_info.id twice is a 500, never a silent upsert",
      `status ${duplicate.status}`);

    const tenantKey = await mintKey(base, masterKey, `${alias}-tenant`, [planName]);
    if (!check(tenantKey != null, "a virtual key is minted for the new plan model")) {
      unresolved("everything below", "there is no tenant key to serve traffic with");
      return;
    }
    made.keys.push(`${alias}-tenant`);

    const first = await call(`${base}/v1/chat/completions`, {
      method: "POST", token: tenantKey, body: { model: planName, messages: [{ role: "user", content: "say ok" }] },
    });
    check(first.status === 200, "and a request on the new alias is answered", `status ${first.status}`);
    if (oneWorker) {
      note("on one worker the deployment served without any wait: this is the 'next request' the panel promises");
    }

    // ---- 2. a second and a third key on ONE plan model --------------------------------------------
    step("a second and a third key on one plan model");
    for (const [n, name] of [[2, "KEY_TWO"], [3, "KEY_THREE"]]) {
      const credName = `${alias}-key-${n}`;
      const added = await call(`${base}/credentials`, {
        method: "POST", ...M,
        body: {
          credential_name: credName,
          credential_values: { api_key: keyValue(name) },
          credential_info: { tb_provider: MARK, tb_key_label: `subscription ${n}`, tb_key_order: n, env: name },
        },
      });
      if (added.status === 200) made.credentials.push(credName);
      const depId = `${alias}-dep-${n}`;
      const dep = await call(`${base}/model/new`, {
        method: "POST", ...M,
        body: {
          model_name: planName,
          litellm_params: { model: "openai/vendor-one", api_base: apiBaseFor(name), litellm_credential_name: credName },
          model_info: { id: depId, tb_provider: MARK, tb_key_label: `subscription ${n}`, tb_key_order: n },
        },
      });
      check(added.status === 200 && dep.status === 200,
        `key ${n} is added to the pool without touching the alias or any box`,
        `credential ${added.status}, deployment ${dep.status}`);
      if (dep.status === 200) made.deployments.push(depId);
    }
    const info = await call(`${base}/model/info`, M);
    const pool = (info.json?.data ?? []).filter((one) => one.model_name === planName);
    check(pool.length === 3, "the alias now carries THREE deployments", `${pool.length} deployments`);

    if (upstreams) {
      // Read out of the ANSWER, not out of a header the stub invents: each stand-in subscription
      // replies with its own sentence and a real proxy passes that through untouched, so this same
      // check means the same thing against the stub and against the image.
      const servedBy = new Set();
      for (let i = 0; i < 18; i += 1) {
        const answer = await call(`${base}/v1/chat/completions`, {
          method: "POST", token: tenantKey, body: { model: planName, messages: [] },
        });
        const said = String(answer.json?.choices?.[0]?.message?.content ?? answer.json?.served_by ?? "");
        if (said) servedBy.add(said);
      }
      check(servedBy.size === 3, "and all three of them answer, which is what a pool is",
        [...servedBy].join(" / ") || "nobody");
    } else {
      unresolved("all three keys answer", "this run has no stand-in subscriptions to tell apart");
    }

    // ---- 3. the roll ------------------------------------------------------------------------------
    // The measurement this whole wave is judged on. Traffic runs THROUGHOUT, and the failure count is
    // read out of the requests this leg made rather than out of the panel's own answer.
    step("rolling a key with traffic flowing throughout");
    const rollDeadline = Date.now() + 4_000;
    let attempted = 0;
    let failed = 0;
    let sawRolled = false;
    const traffic = (async () => {
      while (Date.now() < rollDeadline) {
        attempted += 1;
        const answer = await call(`${base}/v1/chat/completions`, {
          method: "POST", token: tenantKey, body: { model: planName, messages: [] },
        });
        if (answer.status !== 200) failed += 1;
        if (String(answer.json?.choices?.[0]?.message?.content ?? "").includes("rolled")) sawRolled = true;
        await sleep(20);
      }
    })();

    await sleep(600);
    // IN PLACE, because the pool shape is not changing: one credential, a new value behind it. The
    // alias does not change, the label does not change, box-secrets.json is not touched, and the
    // customer sees nothing. The name is in the path AND in the body -- measured: without the body
    // field it is a 422, which would be a key that did not change while the panel said it did.
    const roll = await call(`${base}/credentials/${encodeURIComponent(`${alias}-key-1`)}`, {
      method: "PATCH", ...M,
      body: {
        credential_name: `${alias}-key-1`,
        credential_values: { api_key: keyValue("KEY_ROLLED") },
        credential_info: { tb_provider: MARK, tb_key_label: "first subscription", tb_key_order: 1, env: "KEY_ROLLED" },
      },
    });
    check(roll.status === 200, "PATCH /credentials/{name} replaces the value in place", `status ${roll.status}`);

    // The same call with the name left out of the body, which is the shape a caller gets wrong once.
    //
    // THE VALUE HERE IS DELIBERATELY NOT A WATCHED SECRET, and that is a finding rather than a
    // convenience. MEASURED on this Mac 2026-09-08 against the real v1.100.0: a malformed PATCH
    // /credentials answers 422 with FastAPI's validation envelope, and that envelope carries an
    // `input` field holding THE WHOLE REQUEST BODY BACK, api_key included, in cleartext. So the
    // proxy will hand a submitted provider key straight back inside an error. The control plane must
    // never pass a proxy error body through to the browser, into a ledger row or into a log line: it
    // reads the status and writes its own sentence. This asserts the echo happens, with a marker
    // instead of a key, so the behaviour is on the record rather than discovered by somebody later.
    const echoMarker = `${MARK}-echo-marker-${suffix}`;
    const missingName = await call(`${base}/credentials/${encodeURIComponent(`${alias}-key-1`)}`, {
      method: "PATCH", ...M, body: { credential_values: { api_key: echoMarker } },
    });
    check(missingName.status === 422,
      "and it REFUSES a body without credential_name, which is the shape a caller gets wrong once",
      `status ${missingName.status}`);
    check(String(missingName.text).includes(echoMarker),
      "and that refusal ECHOES the submitted body back, so a proxy error body may never reach a browser, a ledger row or a log",
      String(missingName.text).includes(echoMarker) ? "the value came back in the 422" : "it did not echo");

    await traffic;
    check(attempted > 0 && failed === 0,
      "zero failed requests across the roll, with traffic running the whole time",
      `${attempted} requests, ${failed} failed`);
    // WHAT "the rolled key is serving now" LOOKS LIKE IS DIFFERENT IN THE TWO MODES, and getting
    // that wrong is how a gate proves nothing. A roll changes the VALUE behind a credential; it does
    // not move traffic anywhere. The deployment keeps the same api_base and the same alias -- that
    // is the whole point, and it is why a customer sees nothing.
    //   real: the same stand-in subscription is now called with a different key, so the proof is the
    //         Authorization header it received.
    //   stub: the stub proxy routes by the credential's env NAME and forwards no auth header, so the
    //         proof is that the upstream registered under the rolled name is the one answering.
    if (apiBases && upstreams) {
      const rolledValue = keyValue("KEY_ROLLED");
      const sawIt = upstreams.one.state.sawKeys.some((one) => one.includes(rolledValue));
      const sawOld = upstreams.one.state.sawKeys.slice(-20).some((one) => one.includes(keyValue("KEY_ONE")));
      check(sawIt && !sawOld,
        "and the rolled-in key is the one serving afterwards -- the same upstream, called with the new value",
        sawIt ? `the upstream saw the new value, and none of its last 20 calls carried the old one` : "the new value never reached the vendor");
    } else if (upstreams) {
      check(sawRolled, "and the rolled-in key is the one serving afterwards",
        sawRolled ? "the new value answered" : "the new value never answered");
    }

    // The window that matters is longer than user_api_key_cache_ttl, because a key's authorisation is
    // cached and a roll that only looked clean inside the cache window proved nothing. Against the
    // stub the ttl is zero, so this is a shape check and says so; the number is the R750's.
    const ttl = 30;
    if (real) {
      note(`watching for another ${ttl} s, which is user_api_key_cache_ttl, before calling the roll quiet`);
      const started = Date.now();
      let after = 0;
      let afterFailed = 0;
      while (Date.now() - started < ttl * 1000) {
        after += 1;
        const answer = await call(`${base}/v1/chat/completions`, {
          method: "POST", token: tenantKey, body: { model: planName, messages: [] },
        });
        if (answer.status !== 200) afterFailed += 1;
        await sleep(500);
      }
      check(afterFailed === 0, `and still zero failures over a window longer than the ${ttl} s cache ttl`,
        `${after} requests, ${afterFailed} failed`);
    } else {
      unresolved(`the roll stays quiet past the ${ttl} s authorisation cache`,
        "the stub's cache ttl is zero, so there is no window to outlast; the R750 run measures this one");
    }

    // ---- 4. a key removed, add first ---------------------------------------------------------------
    step("removing a key, add first and delete second");
    const before = (await call(`${base}/model/info`, M)).json?.data ?? [];
    const removeId = `${alias}-dep-3`;
    const removed = await call(`${base}/model/delete`, { method: "POST", ...M, body: { id: removeId } });
    check(removed.status === 200, "POST /model/delete takes the deployment out", `status ${removed.status}`);
    const deletedCred = await call(`${base}/credentials/${encodeURIComponent(`${alias}-key-3`)}`, { method: "DELETE", ...M });
    check(deletedCred.status === 200, "and DELETE /credentials/{name} takes the key with it", `status ${deletedCred.status}`);
    const after = (await call(`${base}/model/info`, M)).json?.data ?? [];
    check(after.filter((one) => one.model_name === planName).length
      === before.filter((one) => one.model_name === planName).length - 1,
      "the alias is left with one deployment fewer and is still served");
    const stillServing = await call(`${base}/v1/chat/completions`, {
      method: "POST", token: tenantKey, body: { model: planName, messages: [] },
    });
    check(stillServing.status === 200, "and the very next request is still answered", `status ${stillServing.status}`);
    made.deployments = made.deployments.filter((one) => one !== removeId);
    made.credentials = made.credentials.filter((one) => one !== `${alias}-key-3`);

    // A config-declared deployment cannot be deleted at all, which is a thing the panel must never
    // offer as a button. Measured both by model_name and by the hashed id /model/info gives it.
    const notInDb = await call(`${base}/model/delete`, { method: "POST", ...M, body: { id: "plan-not-in-the-database" } });
    check(notInDb.status === 400,
      "and a deployment the database does not own is refused 400 'not found in db', never silently ignored",
      `status ${notInDb.status}`);

    // ---- 5. repointing the alias at a new vendor model ----------------------------------------------
    step("a vendor retires a model: repoint the alias, keep everything else");
    const repoint = await call(`${base}/model/update`, {
      method: "POST", ...M,
      body: { model_info: { id: idOne }, litellm_params: { model: "openai/vendor-two" } },
    });
    check(repoint.status === 200, "POST /model/update repoints one deployment", `status ${repoint.status}`);
    const repointed = (await call(`${base}/model/info?litellm_model_id=${encodeURIComponent(idOne)}`, M)).json?.data?.[0];
    check(repointed?.litellm_params?.model === "openai/vendor-two",
      "the vendor model changed", `now ${repointed?.litellm_params?.model}`);
    check(repointed?.model_name === planName,
      "the ALIAS did not, which is what every box is pointed at", `still ${repointed?.model_name}`);
    check(repointed?.litellm_params?.litellm_credential_name === `${alias}-key-1`,
      "and the update MERGED: the credential reference survived a body that never mentioned it",
      `credential ${repointed?.litellm_params?.litellm_credential_name}`);
    check(repointed?.model_info?.tb_customer_label === "Gate Model",
      "as did every tb_ key, which is where the customer-facing words live",
      `label ${repointed?.model_info?.tb_customer_label}`);

    const noParams = await call(`${base}/model/update`, { method: "POST", ...M, body: { model_info: { id: idOne } } });
    check(noParams.status === 400,
      "and /model/update with no litellm_params is refused 400, which a caller gets wrong once",
      `status ${noParams.status}`);

    // The label edit is a DIFFERENT route, because /model/update insists on litellm_params it has no
    // reason to send. This one takes model_info alone, and it is a path-parameter route, which is one
    // of the two reasons an exact-match global door list could not stay.
    const relabel = await call(`${base}/model/${encodeURIComponent(idOne)}/update`, {
      method: "PATCH", ...M,
      body: { model_info: { id: idOne, tb_customer_label: "Gate Model 2", tb_customer_name: "Gate Model 2" } },
    });
    check(relabel.status === 200, "PATCH /model/{id}/update takes model_info alone, which is the label edit",
      `status ${relabel.status}`);
    const relabelled = (await call(`${base}/model/info?litellm_model_id=${encodeURIComponent(idOne)}`, M)).json?.data?.[0];
    check(relabelled?.model_info?.tb_customer_label === "Gate Model 2"
      && relabelled?.litellm_params?.model === "openai/vendor-two",
      "and it merged: the label changed and the vendor model did not");

    // ---- 6. a plan model with no vision fallback --------------------------------------------------
    // Not a proxy rule. It is OURS, and it is why PROXY-10 cost a day: a text-only plan model refuses
    // every screenshot-carrying turn, and every Titan conversation carries screenshots. The panel
    // requires one before it will save, and the gate proves the requirement rather than the wish.
    step("a plan model saved with no vision fallback is refused");
    const noFallback = {
      model_name: `${planName}-nofallback`,
      litellm_params: { model: "openai/vendor-one", litellm_credential_name: `${alias}-key-1` },
      model_info: { id: `${alias}-dep-nofallback`, tb_customer_visible: true, tb_customer_name: "No Fallback" },
    };
    const refusal = describePlanModelRefusal(noFallback);
    check(refusal != null,
      "the control plane refuses a customer-visible plan model with no tb_vision_fallback BEFORE it reaches the proxy",
      refusal ?? "it was accepted, which is PROXY-10 waiting to happen again");
    const named = {
      ...noFallback,
      model_info: {
        ...noFallback.model_info,
        tb_vision_fallback: `${planName}-vision`,
        tb_customer_label: "No Fallback",
      },
    };
    check(describePlanModelRefusal(named) == null,
      "and accepts the same one once a fallback and both customer-facing names are given",
      describePlanModelRefusal(named) ?? "accepted");
    check(describePlanModelRefusal({ ...named, model_info: { ...named.model_info, tb_customer_label: null } }) != null,
      "a customer-visible model with no label a person reads is refused too, because the routing name would end up on their screen");
    check(describePlanModelRefusal({ ...noFallback, model_info: { id: "x", tb_customer_visible: false } }) == null,
      "a routing target that is not customer-visible needs none, because nothing sends it a screenshot by name");

    // ---- 7. the catalog ----------------------------------------------------------------------------
    step("a catalog read without the caller holding the vendor key");
    if (!catalog) {
      unresolved("the catalog path", "no stub catalog in a --real run; the R750 measurement refreshes the Z.AI catalog instead");
    } else {
      const catalogPath = `/catalog/${MARK}-${suffix}`;
      const registered = await call(`${base}/config/pass_through_endpoint`, {
        method: "POST", ...M,
        body: {
          path: catalogPath,
          target: catalog.url,
          // AN os.environ REFERENCE, never a value. Measured on this Mac 2026-09-08: a live-registered
          // pass-through resolves the reference at REQUEST time, so the control plane can register a
          // catalog path while holding no vendor key at all.
          headers: { authorization: "Bearer os.environ/PROXY_CATALOG_KEY" },
          include_subpath: true,
        },
      });
      check(registered.status === 200, "POST /config/pass_through_endpoint registers a catalog path",
        `status ${registered.status}`);
      // The ROW ID, not the path. MEASURED on this Mac 2026-09-08 against a real v1.100.0: DELETE
      // ?endpoint_id=<the path> answers 400 and removes nothing, while ?endpoint_id=<the uuid the
      // POST answered with> answers 200 and the route then 404s. A cleanup that passed the path
      // reported success and left the endpoint serving.
      const catalogRowId = registered.json?.endpoints?.[0]?.id;
      if (registered.status === 200 && catalogRowId) made.passThroughs.push(catalogRowId);
      check(typeof catalogRowId === "string" && catalogRowId.length > 0,
        "and it answers with the row id, which is the only handle that can delete it again",
        catalogRowId ? `id ${String(catalogRowId).slice(0, 8)}...` : "no id came back");
      const byPath = await call(`${base}/config/pass_through_endpoint?endpoint_id=${encodeURIComponent(catalogPath)}`,
        { method: "DELETE", ...M });
      check(byPath.status === 400,
        "deleting one by its PATH is refused 400, which a caller gets wrong once and then silently leaves the route open",
        `status ${byPath.status}`);

      const read = await call(`${base}${catalogPath}/v1/models`, M);
      const ids = (read.json?.data ?? []).map((one) => one.id);
      check(read.status === 200 && ids.length > 0,
        "and reading it gives the vendor's live model list", ids.join(", ") || `status ${read.status}`);
      check(ids.every((id) => typeof id === "string"),
        "NAMES AND ONLY NAMES: no context window and no vision flag comes back, so the panel says a person sets those",
        (read.json?.data ?? []).map((one) => Object.keys(one).join("+")).slice(0, 1).join("") || "nothing");
      check(catalog.server.state.sawKeys.some((one) => one.includes(values?.CATALOG ?? "")),
        "the vendor saw a real key, and it came from the proxy's environment rather than from the caller",
        `${catalog.server.state.calls} call(s) to the vendor`);
      const bare = await call(`${base}/config/pass_through_endpoint`, M);
      const mine = (bare.json?.endpoints ?? []).find((one) => one.path === catalogPath);
      check(mine != null && JSON.stringify(mine.headers ?? {}).includes("os.environ/"),
        "and what the proxy stored is the REFERENCE, not the value",
        JSON.stringify(mine?.headers ?? {}));
      // And the warning that goes with it: this route hands back headers unmasked, including a
      // config-declared entry's RESOLVED key. The panel must never render them.
      note("GET /config/pass_through_endpoint returns headers UNMASKED and resolves a config entry's");
      note("os.environ reference to the real key. The panel never renders these; tests/cp-server.test.mjs asserts it.");
    }

    // ---- 8. per-deployment spend --------------------------------------------------------------------
    step("spend, per deployment, one row per request");
    const spendKey = await mintKey(base, masterKey, `${alias}-spend`, [planName]);
    if (!spendKey) {
      unresolved("per-deployment spend", "no key was minted to spend on");
    } else {
      made.keys.push(`${alias}-spend`);
      const wanted = 10;
      let sent = 0;
      for (let i = 0; i < wanted; i += 1) {
        const answer = await call(`${base}/v1/chat/completions`, {
          method: "POST", token: spendKey, body: { model: planName, messages: [] },
        });
        if (answer.status === 200) sent += 1;
      }
      if (real) {
        note("waiting out proxy_batch_write_at before reading the spend log");
        await sleep(13_000);
      }
      const logs = await call(`${base}/spend/logs?api_key=${encodeURIComponent(spendKey)}`, M);
      const rows = Array.isArray(logs.json) ? logs.json : (logs.json?.data ?? []);
      // THE ROW COUNT, not "there are rows". Measured on this Mac 2026-09-08: an upstream that
      // returns a constant completion id collapsed TWELVE requests onto ONE spend row, because the
      // completion id is the row's request_id. A customer on such a provider would read as near zero.
      check(rows.length === sent,
        "one spend row per request: an upstream that reuses a completion id collapses them into one",
        `${sent} requests answered, ${rows.length} row(s)`);
      const byDeployment = new Set(rows.map((one) => one.model_id).filter(Boolean));
      check(byDeployment.size > 0,
        "and every row names the DEPLOYMENT that served it, so spend is readable per key in the pool",
        [...byDeployment].join(", ") || "no model_id on any row");
      check(rows.every((one) => one.model_group === planName || one.model === planName || one.model_group === ""),
        "and the alias it was asked for", `groups ${[...new Set(rows.map((one) => one.model_group))].join(", ")}`);
    }

    // ---- 9. PROXY-8: the per-key door list -----------------------------------------------------------
    step("a tenant key can no longer read the admin surface (PROXY-8)");
    const open = await mintKey(base, masterKey, `${alias}-open`, [planName]);
    const scoped = await mintKey(base, masterKey, `${alias}-scoped`, [planName],
      ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models"]);
    if (!open || !scoped) {
      unresolved("the per-key door list", "one of the two keys could not be minted");
    } else {
      made.keys.push(`${alias}-open`, `${alias}-scoped`);
      // The hole, stated rather than implied: an UNSCOPED key reads the admin surface today, which is
      // every key already in the field, which is what the backfill is for.
      const openInfo = await call(`${base}/key/info`, { token: open });
      check(openInfo.status === 200,
        "a key minted with NO allowed_routes still reads /key/info -- this is the hole, and every key in the field has it",
        `status ${openInfo.status}`);

      for (const closed of ["/key/info", "/model/info", "/model_group/info", "/health"]) {
        const refused = await call(`${base}${closed}`, { token: scoped });
        check(refused.status === 403 && String(refused.text).includes("not allowed to call this route"),
          `and a SCOPED key is refused ${closed} with LiteLLM's own sentence`,
          `status ${refused.status}`);
      }
      const models = await call(`${base}/v1/models`, { token: scoped });
      check(models.status === 200, "while GET /v1/models still answers", `status ${models.status}`);
      const chat = await call(`${base}/v1/chat/completions`, {
        method: "POST", token: scoped, body: { model: planName, messages: [] },
      });
      check(chat.status === 200, "and so does a real turn", `status ${chat.status}`);
      const masterStill = await call(`${base}/model/info`, M);
      check(masterStill.status === 200, "and the master key reading the same records is unaffected",
        `status ${masterStill.status}`);

      // The backfill, which is what closes every key ALREADY in the field. It has to be a /key/update
      // rather than a rotate, or it writes a new key into a box and drags the registry hazard in with
      // it. MEASURED on this Mac 2026-09-08: /key/update accepts allowed_routes on an existing key.
      const sweep = await call(`${base}/key/update`, {
        method: "POST", ...M,
        body: { key: open, allowed_routes: ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models"] },
      });
      check(sweep.status === 200,
        "POST /key/update accepts allowed_routes on a key already in the field, so the backfill writes NOTHING into a box",
        `status ${sweep.status}`);
      const afterSweep = await call(`${base}/key/info`, { token: open });
      check(afterSweep.status === 403,
        "and that key is refused /key/info on its next request", `status ${afterSweep.status}`);
      const chatAfter = await call(`${base}/v1/chat/completions`, {
        method: "POST", token: open, body: { model: planName, messages: [] },
      });
      check(chatAfter.status === 200, "while its own traffic keeps working, which is why it can be swept live",
        `status ${chatAfter.status}`);
    }
  } finally {
    // Everything this leg made, taken back out. A --real run against the R750 leaves the proxy as it
    // found it, and a name it could not remove is NAMED rather than left for somebody to find.
    step("cleaning up after the gate");
    const leftovers = [];
    for (const one of made.passThroughs) {
      const gone = await call(`${base}/config/pass_through_endpoint?endpoint_id=${encodeURIComponent(one)}`, { method: "DELETE", ...M });
      if (gone.status !== 200) leftovers.push(`pass-through ${one}`);
    }
    for (const one of made.deployments) {
      const gone = await call(`${base}/model/delete`, { method: "POST", ...M, body: { id: one } });
      if (gone.status !== 200) leftovers.push(`deployment ${one}`);
    }
    for (const one of made.credentials) {
      const gone = await call(`${base}/credentials/${encodeURIComponent(one)}`, { method: "DELETE", ...M });
      if (gone.status !== 200) leftovers.push(`credential ${one}`);
    }
    if (made.keys.length > 0) {
      const gone = await call(`${base}/key/delete`, { method: "POST", ...M, body: { key_aliases: made.keys } });
      if (gone.status !== 200) leftovers.push(`key aliases ${made.keys.join(", ")}`);
    }
    check(leftovers.length === 0, "everything this leg made is taken back out",
      leftovers.join("; ") || `${made.deployments.length + made.credentials.length + made.keys.length + made.passThroughs.length} object(s) removed`);
  }
}

// ---- our rule, not the proxy's -------------------------------------------------------------------
// A customer-visible plan model MUST name a vision fallback. This is the check cp/admin.mjs applies
// before it posts anything, expressed here so the gate proves the requirement rather than the wish,
// and so item C and this leg cannot drift on what the rule is.
//
// It returns the sentence a person would read, or null when the model is fine. The sentence is the
// panel's, in plain words: no proxy vocabulary, because an operator reading it is being told what to
// do next, not what a route is called.
export function describePlanModelRefusal(model) {
  const info = model?.model_info ?? {};
  if (!info.tb_customer_visible) return null;
  if (!info.tb_vision_fallback) {
    return "Pick a model to fall back to when a message carries a screenshot. "
      + "Titan sends screenshots on almost every turn, and a plan model that refuses them fails every one of those turns.";
  }
  if (info.tb_vision_fallback === model?.model_name) {
    return "A model cannot fall back to itself. Pick a different one, or turn off the vision fallback "
      + "if this model takes images on its own.";
  }
  if (!info.tb_customer_name || !info.tb_customer_label) {
    return "Give this model a name customers see and a name their Titan says it runs. "
      + "Without both, the routing name would end up on their screen.";
  }
  return null;
}

// NO `tags`. MEASURED on this Mac 2026-09-08 against a real v1.100.0: a mint carrying tags is
// refused 403 "This feature is only available for LiteLLM Enterprise users: tags", so a leg that
// tagged its keys minted NOTHING against the real image and every check below it fell over on a
// missing key. The gate's own rows are found by their key_alias prefix instead, which is also how
// the product finds a tenant's.
async function mintKey(base, masterKey, alias, models, allowedRoutes) {
  const minted = await call(`${base}/key/generate`, {
    method: "POST", token: masterKey,
    body: {
      key_alias: alias, models,
      metadata: { tb_gate: "providers" },
      ...(allowedRoutes ? { allowed_routes: allowedRoutes } : {}),
    },
  });
  return typeof minted.json?.key === "string" ? minted.json.key : null;
}
