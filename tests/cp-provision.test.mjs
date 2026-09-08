// TENANT-1, amended by TENANT-5. Provisioning: the slug rules, the name a company name turns into,
// the one-service box compose a tenant gets, the dry run that creates nothing, a full run against a
// fake Coolify that answers the way the openapi says, the wait for the box, and the retry that picks
// up at the step that failed instead of building a second half-instance.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  BOX_COMPOSE_PATH,
  boxDefaultNames,
  writeBoxDefaults,
  RESERVED_SLUGS,
  boxContainerName,
  coolifyStatusOf,
  deriveSlug,
  loadConfig,
  readCoolifyState,
  readProxyKey,
  provisionTenant,
  renderBoxCompose,
  slugFromCompany,
  tenantDirectoryList,
  tenantPaths,
  validateSlug,
  waitForBox,
} from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";
import { makeTempRoot, startFakeCoolify } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const SESSION_SECRET = randomBytes(32).toString("hex");

async function withWorld(run, options = {}) {
  const root = await makeTempRoot("cp-provision-");
  const coolify = options.coolify ?? null;
  const config = loadConfig({
    CP_DATA_DIR: path.join(root, "data"),
    CP_SESSION_SECRET: SESSION_SECRET,
    CP_ADMIN_TOKEN: randomBytes(24).toString("hex"),
    CP_BASE_DOMAIN: "titanium.bot",
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: "/home/sem/titanbot",
    CP_PUBLIC_URL: "https://api.titanium.bot",
    COOLIFY_URL: coolify?.url ?? "",
    COOLIFY_API_KEY: coolify?.apiKey ?? "",
    COOLIFY_PROJECT_UUID: "project-uuid-1",
    COOLIFY_SERVER_UUID: "server-uuid-1",
    COOLIFY_ENVIRONMENT_NAME: "production",
    // The wait for the box, kept short here. A real run waits 90 seconds for an image the server
    // may not have; a test that did would be a test nobody runs.
    CP_BOX_READY_TIMEOUT_MS: "40",
    CP_BOX_READY_INTERVAL_MS: "10",
    ...(options.env ?? {}),
  });
  const store = openStore({ dataDir: config.dataDir });
  try { await run({ config, store, root }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

// A run with the gateway probe turned off, so the only thing that can answer "ready" is Coolify's
// own container status. Every provisioning test here uses it: a fetch to titanbot-box-svc-xxxx:1340
// from this Mac would sit there resolving a name that is only meaningful inside the R750's docker.
const noGateway = () => { throw new Error("there is no docker network in a test"); };

// ---- the slug ------------------------------------------------------------------------------------

test("a tenant name is three to thirty-two lowercase characters", () => {
  assert.equal(validateSlug("acme").ok, true);
  assert.equal(validateSlug("a1-b2-c3").ok, true);
  assert.equal(validateSlug("a".repeat(32)).ok, true);

  assert.equal(validateSlug("ab").ok, false);
  assert.equal(validateSlug("a".repeat(33)).ok, false);
  assert.equal(validateSlug("Acme").ok, false);
  assert.equal(validateSlug("acme roofing").ok, false);
  assert.equal(validateSlug("acme_roofing").ok, false);
  assert.equal(validateSlug("acme.roofing").ok, false);
  assert.equal(validateSlug("acme/../etc").ok, false);
  assert.equal(validateSlug("").ok, false);
  assert.equal(validateSlug(null).ok, false);
  // A hostname label cannot begin or end with a dash, so the web address would never resolve.
  assert.equal(validateSlug("-acme").ok, false);
  assert.equal(validateSlug("acme-").ok, false);
});

test("the reserved names are all refused, and the message says to pick another", () => {
  const expected = ["www", "console", "api", "mail", "app", "admin", "status", "docs", "blog", "help", "support", "titanium", "titan", "resend", "send", "rsend", "_dmarc"];
  assert.deepEqual([...RESERVED_SLUGS].sort(), expected.sort());
  for (const name of expected) {
    if (name === "_dmarc") continue; // refused by the character rule before the list is reached
    const verdict = validateSlug(name);
    assert.equal(verdict.ok, false, `${name} should be reserved`);
    assert.match(verdict.reason, /reserved/);
  }
  // The mail names matter because titanium.bot already publishes records on them, and handing one
  // to a customer would point their instance at where mail authentication is answered from.
  assert.equal(validateSlug("resend").ok, false);
  assert.equal(validateSlug("_dmarc").ok, false);
});

test("the messages are plain words with no jargon and no em dashes", () => {
  for (const bad of ["ab", "Acme", "-acme", "www"]) {
    const verdict = validateSlug(bad);
    assert.equal(verdict.ok, false);
    assert.doesNotMatch(verdict.reason, /—/);
    assert.doesNotMatch(verdict.reason, /regex|slug|validation|invalid/i);
  }
});

// ---- a name from a company name ----------------------------------------------------------------

test("a company name becomes a workspace name a customer would recognise", () => {
  assert.equal(slugFromCompany("Acme Roofing"), "acme-roofing");
  assert.equal(slugFromCompany("Acme Roofing & Sons, LLC"), "acme-roofing-sons-llc");
  assert.equal(slugFromCompany("  Acme  "), "acme");
  // Accents are folded rather than dropped, so a name stays readable.
  assert.equal(slugFromCompany("Café Noir"), "cafe-noir");
  // Nothing to name it after.
  assert.equal(slugFromCompany("!!!"), "");
  assert.equal(slugFromCompany(""), "");
  assert.equal(slugFromCompany(null), "");
  // Cut to the length a name may be, with no dash left dangling on the end.
  assert.equal(slugFromCompany("a".repeat(40)).length, 32);
  assert.equal(slugFromCompany(`${"a".repeat(31)} roofing`), "a".repeat(31));
});

test("the name a company gets is free, legal and never reserved", () => {
  assert.equal(deriveSlug("Acme Roofing"), "acme-roofing");
  // Taken, so the next one along.
  assert.equal(deriveSlug("Acme Roofing", (name) => name === "acme-roofing"), "acme-roofing-2");
  assert.equal(deriveSlug("Acme", (name) => ["acme", "acme-2", "acme-3"].includes(name)), "acme-4");
  // A company whose name IS a reserved word does not get the reserved word.
  assert.equal(deriveSlug("Titanium"), "titanium-2");
  assert.equal(deriveSlug("API"), "api-2");
  // Two characters is under the minimum, and a refusal they could do nothing about would be worse.
  assert.equal(deriveSlug("GK"), "gk-workspace");
  // Nothing to work with.
  assert.equal(deriveSlug("!!!"), null);
  assert.equal(deriveSlug(""), null);
  // Every answer is a name this service would accept.
  for (const company of ["Acme Roofing", "Titanium", "GK", "Café Noir", "a".repeat(40)]) {
    assert.equal(validateSlug(deriveSlug(company)).ok, true, `${company} produced a name this service refuses`);
  }
});

// ---- the compose ----------------------------------------------------------------------------------

test("the rendered compose points at this tenant's own directories and nobody else's", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderBoxCompose({ slug: "acme", config });
    const paths = tenantPaths("acme", config);

    // The four data mounts, off the shared docker volumes and onto this tenant's tree.
    assert.match(rendered, new RegExp(`- ${paths.workspace}:/workspace`));
    assert.match(rendered, new RegExp(`- ${paths.data}:/home/box/sand-data`));
    assert.match(rendered, new RegExp(`- ${paths.store}:/var/lib/sand-box-store`));
    assert.match(rendered, new RegExp(`- ${paths.chrome}:/home/box/chrome-profile`));
    assert.equal(rendered.includes("/data/docker/volumes/titanbot-box-"), false, "no tenant may point at the shared docker volumes");

    // Per tenant: the credential placeholder.
    assert.match(rendered, new RegExp(`- ${paths.credential}:/run/grok-bot:ro`));

    // Shared by every tenant: one copy of the release on the host, so an update is one ship.
    assert.match(rendered, /- \/home\/sem\/titanbot\/runtime:\/opt\/titanbot-runtime:ro/);
    assert.match(rendered, /- \/home\/sem\/titanbot\/runtime\/box-exec-daemon:\/home\/box\/box-exec-daemon:ro/);

    // The box's own repairs travel with it. A tenant has no docker socket, so anything done to the
    // box from outside never happens there; sqlite3 is installed by the box's entrypoint instead.
    assert.match(rendered, /command -v sqlite3/);
    assert.match(rendered, /apt-get install -y -qq sqlite3/);
  });
});

test("a tenant is one container on the shared network, with an alias that does not move", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderBoxCompose({ slug: "acme", config });

    // One service, and it is the box. No relay, so nothing about this customer is public.
    const services = rendered.split(/^services:$/m)[1].split(/^\S/m)[0];
    assert.deepEqual(services.match(/^ {2}\S+:$/gm), ["  titanbot-box:"]);

    // The network the one relay is on, declared external so a deploy neither creates nor renames it.
    assert.match(rendered, /^networks:$/m);
    assert.match(rendered, /^ {2}titanbot-net:\n {4}external: true\n {4}name: titanbot-net$/m);
    // And the box joins it, under a name that survives a rebuild with a new service uuid.
    assert.match(rendered, /^ {4}networks:\n {6}titanbot-net:\n {8}aliases:\n {10}- titanbot-box-acme$/m);

    // No hostname anywhere, and nothing published on a server interface.
    assert.equal(/^\s*ports:/m.test(rendered), false, "a customer's box is never on a server port");
    assert.equal(rendered.includes("acme.titanium.bot"), false, "a tenant has no hostname of its own");
    assert.match(rendered, /console       https:\/\/console\.titanium\.bot/);
  });
});

test("the network and the relay's name on it can be called something else", async () => {
  await withWorld(async ({ config }) => {
    const renamed = { ...config, sharedNetwork: "titan-mesh", relayHost: "the-console" };
    const rendered = renderBoxCompose({ slug: "acme", config: renamed });
    assert.match(rendered, /^ {2}titan-mesh:\n {4}external: true\n {4}name: titan-mesh$/m);
    assert.match(rendered, /SAND_HOST_BUNDLE_S3_BASE_URL: http:\/\/the-console:7777\/runtime\//);
    // Including in the comments, so a rendered file never explains a name it does not use.
    assert.equal(rendered.includes("titanbot-net"), false);
    assert.equal(rendered.includes("titanbot-relay"), false);
  });
});

test("no tenant gets the docker socket, because a socket in that container is root on the host", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderBoxCompose({ slug: "acme", config });
    assert.equal(
      /docker\.sock/.test(rendered),
      false,
      "a container with the host socket is root on the R750 and holds every other customer's files",
    );
    // And nothing that would let this customer read the operator's own console files.
    assert.equal(rendered.includes("/app/ui"), false);
    assert.equal(rendered.includes("/home/sem/titanbot/ui"), false);
    assert.equal(rendered.includes("/home/sem/titanbot/state"), false);
  });
});

test("the tenant's Coolify environment gets its gateway token and no session key at all", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);

      const keys = coolify.callsTo("POST /services/{uuid}/envs").map((call) => call.body.key);
      assert.deepEqual(keys, ["TITANBOT_GATEWAY_TOKEN"]);
      // The session key used to be written here, because the tenant had a relay of its own to
      // verify with it. It has no relay: the one relay is handed each tenant's derived key over
      // GET /v1/relay/tenants, and Coolify's environment store never holds it.
      const stored = JSON.stringify([...coolify.services.values()]);
      assert.equal(stored.includes("CP_SESSION_SECRET"), false);
      assert.equal(stored.includes(config.sessionSecret), false, "the master never leaves this process");
    }, { coolify });
  } finally { await coolify.close(); }
});

test("the rendered compose names the tenant and nothing about a hostname", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderBoxCompose({ slug: "acme", config });
    // Once as the network alias and once as TENANT_ID.
    assert.equal(rendered.split("acme").length - 1 >= 2, true);
    assert.match(rendered, /^ {6}TENANT_ID: acme$/m);
    assert.match(rendered, /SAND_GATEWAY_TOKEN: \$\{TITANBOT_GATEWAY_TOKEN\}/);
    assert.match(rendered, /^# Rendered for tenant "acme"/);
    // The two the tenant compose used to carry, gone with the relay they belonged to.
    assert.equal(rendered.includes("CP_URL:"), false);
    assert.equal(rendered.includes("CP_SESSION_SECRET"), false);
  });
});

test("no secret of any kind is in the compose text", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "console.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);

      const paths = tenantPaths("acme", config);
      const gatewayToken = JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token;
      const rendered = renderBoxCompose({ slug: "acme", config });

      assert.equal(rendered.includes(gatewayToken), false, "the gateway token is a Coolify env, never compose text");
      assert.equal(rendered.includes(config.sessionSecret), false, "the session secret never leaves the control plane");

      // The same is true of what Coolify was handed: the compose it stores carries references only.
      const created = coolify.callsTo("POST /services")[0];
      const stored = Buffer.from(created.body.docker_compose_raw, "base64").toString("utf8");
      assert.equal(stored.includes(gatewayToken), false);
      assert.equal(stored.includes(config.sessionSecret), false);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("rendering refuses to guess when the box compose has moved underneath it", async () => {
  await withWorld(async ({ config }) => {
    const base = readFileSync(BOX_COMPOSE_PATH, "utf8");
    const withoutTheVolume = base.replace("/data/docker/volumes/titanbot-box-chrome/_data", "/somewhere/else");
    assert.throws(() => renderBoxCompose({ slug: "acme", config, composeText: withoutTheVolume }), /no longer has/);

    // A template that lost the network is not a template this renderer will ship a tenant from: a
    // box on nothing but its own Coolify network is a customer the one relay cannot reach.
    const withoutTheNetwork = base.split("titanbot-net").join("some-other-net");
    assert.throws(() => renderBoxCompose({ slug: "acme", config, composeText: withoutTheNetwork }), /no longer has/);

    // And one that lost a place to write the tenant's name.
    const withoutTheName = base.split("TENANT_SLUG").join("titanium");
    assert.throws(() => renderBoxCompose({ slug: "acme", config, composeText: withoutTheName }), /no longer has/);

    // Half the substitutions is worse than none: it would render a tenant whose alias is its own
    // and whose TENANT_ID is somebody else's.
    const halfTheName = base.replace("TENANT_SLUG", "titanium");
    assert.throws(() => renderBoxCompose({ slug: "acme", config, composeText: halfTheName }), /expects 2/);
  });
});

// ---- the dry run ------------------------------------------------------------------------------------

test("a dry run reads and renders everything and creates nothing", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", dryRun: true });
      assert.equal(result.ok, true);
      assert.equal(result.dryRun, true);
      // No urls step. A tenant has no hostname of its own any more. proxy-key is the eighth,
      // added by PROXY-1 and sitting between envs and start, and it is a step of its own because
      // completedSteps skips one that is already ok: demo and richard-avery have all seven of the
      // others marked ok on the R750, so anything folded into an existing step never runs for them.
      assert.deepEqual(result.plan.steps.map((step) => step.name), ["directories", "secrets", "compose", "service", "envs", "proxy-key", "start", "ready"]);
      assert.equal(result.plan.steps[3].method, "POST");
      assert.equal(result.plan.steps[3].path, "/services");
      assert.equal(result.plan.steps[3].bodyPreview.name, "titanbot-acme");
      assert.equal(result.plan.steps[3].bodyPreview.project_uuid, "project-uuid-1");
      assert.equal(result.plan.steps[3].bodyPreview.server_uuid, "server-uuid-1");
      assert.equal(result.plan.steps[3].bodyPreview.environment_name, "production");
      assert.equal(result.plan.steps[3].bodyPreview.instant_deploy, false);
      assert.equal(JSON.stringify(result.plan).includes("urls"), false, "nothing in the plan sets a hostname");
      assert.equal(result.host, "console.titanium.bot", "everybody signs in at the one console");
      assert.ok(result.composeSha256.length === 64, "the plan says which compose it rendered");

      // Nothing on Coolify.
      assert.deepEqual(coolify.routes(), []);
      // Nothing on the disk.
      for (const directory of tenantDirectoryList("acme", config)) assert.equal(existsSync(directory), false, `${directory} should not exist`);
      // And the plan is on the record, which is what makes it reviewable afterwards.
      const steps = store.listSteps("acme");
      assert.equal(steps.length, 1);
      assert.equal(steps[0].step, "plan");
      assert.equal(steps[0].status, "dry-run");
      assert.deepEqual(JSON.parse(steps[0].detail).steps.map((step) => step.name), result.plan.steps.map((step) => step.name));
    }, { coolify });
  } finally { await coolify.close(); }
});

test("the plan preview never carries a value, only the names of the keys", async () => {
  await withWorld(async ({ config, store }) => {
    const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", dryRun: true });
    const envs = result.plan.steps.find((step) => step.name === "envs");
    assert.deepEqual(envs.bodyPreview.keys, ["TITANBOT_GATEWAY_TOKEN"]);
    assert.equal(envs.bodyPreview.values, "(set)");
    const text = JSON.stringify(result.plan);
    assert.equal(text.includes(SESSION_SECRET), false);
  });
});

// ---- a real run --------------------------------------------------------------------------------------

test("provisioning walks the steps and calls Coolify the way the openapi documents", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "console.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);
      // proxy-key is not in `ran` because this world has no CP_PROXY_URL, which is every install
      // that has not turned the proxy on. It is recorded as skipped rather than ok, so the day one
      // is configured the next run actually mints instead of thinking it already had.
      assert.deepEqual(result.ran, ["directories", "secrets", "compose", "service", "envs", "start", "ready"]);
      const proxyStep = store.listSteps("acme").find((step) => step.step === "proxy-key");
      assert.equal(proxyStep.status, "skipped");
      assert.match(proxyStep.detail, /CP_PROXY_URL/);
      assert.equal(store.completedSteps("acme").has("proxy-key"), false, "a skipped step must not count as done");

      // One POST that answers 409 and one PATCH behind it. Coolify makes an empty field for every
      // ${VAR} the compose names as soon as the service exists, so the field this key goes in is
      // already there and only a PATCH fills it. The POST goes first anyway because a retry of a
      // half-finished provision can find it missing. Then the start, then the read that waits for
      // the box, and no PATCH of the service itself: nothing sets a hostname.
      assert.deepEqual(coolify.routes(), [
        "POST /services",
        "POST /services/{uuid}/envs",
        "PATCH /services/{uuid}/envs",
        "POST /services/{uuid}/start",
        "GET /services/{uuid}",
        "GET /services/{uuid}/applications",
      ]);
      assert.equal(coolify.callsTo("PATCH /services/{uuid}").length, 0, "no tenant is given a hostname");

      // And what Coolify reports for a tenant is ONE container, because that is what a tenant is.
      const listed = await (await fetch(`${coolify.url}/api/v1/services/${store.getTenant("acme").coolifyServiceUuid}/applications`, {
        headers: { authorization: `Bearer ${coolify.apiKey}` },
      })).json();
      assert.deepEqual(listed.map((row) => row.name), ["titanbot-box"]);

      // And the value did land, which is the thing the 409 hid on the R750.
      const stored = [...coolify.services.values()][0].envs;
      const entry = stored.find((one) => one.key === "TITANBOT_GATEWAY_TOKEN");
      assert.ok(entry != null && String(entry.value).length > 0, "TITANBOT_GATEWAY_TOKEN was left empty");

      const created = coolify.callsTo("POST /services")[0];
      assert.equal(created.authorized, true);
      assert.equal(created.body.name, "titanbot-acme");
      assert.equal(created.body.project_uuid, "project-uuid-1");
      assert.equal(created.body.environment_name, "production");
      assert.equal(created.body.server_uuid, "server-uuid-1");
      assert.equal(created.body.instant_deploy, false);
      assert.match(Buffer.from(created.body.docker_compose_raw, "base64").toString("utf8"), /TENANT_ID: acme/);

      const envs = coolify.callsTo("POST /services/{uuid}/envs").map((call) => call.body.key);
      assert.deepEqual(envs, ["TITANBOT_GATEWAY_TOKEN"]);

      const tenant = store.getTenant("acme");
      assert.match(tenant.coolifyServiceUuid, /^svc-/);
      // The container the relay will talk to, written down rather than rebuilt at read time.
      assert.equal(tenant.boxContainer, boxContainerName(tenant.coolifyServiceUuid));
      assert.equal(result.boxContainer, tenant.boxContainer);
      // The fake starts the service when it is asked to, so the wait sees it running and says so.
      assert.equal(tenant.boxReady, true);
      assert.equal(tenant.status, "running");
      assert.equal(tenant.host, "console.titanium.bot");
      assert.equal(tenant.lastError, null);
      assert.deepEqual(store.listSteps("acme").map((step) => `${step.step}:${step.status}`), [
        "directories:ok", "secrets:ok", "compose:ok", "service:ok", "envs:ok", "proxy-key:skipped", "start:ok", "ready:ok",
      ]);
      assert.equal(JSON.parse(store.listSteps("acme").at(-1).detail).how, "coolify");
    }, { coolify });
  } finally { await coolify.close(); }
});

test("a box that never answers leaves the workspace still starting, not failed", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme" });
      // Coolify answers "the containers are not up", which is what a 5.2 GB image pull looks like
      // for the first few minutes.
      coolify.stayStopped = true;
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(result.ok, true, "a slow box is not a failed tenant");
      assert.equal(result.boxReady, false);
      assert.match(result.boxNote, /still starting/);
      assert.doesNotMatch(result.boxNote, /—/);

      const tenant = store.getTenant("acme");
      assert.equal(tenant.status, "provisioning");
      assert.equal(tenant.boxReady, false);
      assert.equal(tenant.lastError, null, "waiting is not an error");
      // Recorded as waiting, not ok, so the next run waits again rather than assuming.
      assert.equal(store.listSteps("acme").at(-1).step, "ready");
      assert.equal(store.listSteps("acme").at(-1).status, "waiting");
      assert.equal(store.completedSteps("acme").has("ready"), false);

      // And the retry is exactly the wait, because everything else is done. The image finished
      // pulling in the meantime and the container came up, which is what the operator would have
      // seen in Coolify while they waited.
      coolify.stayStopped = false;
      [...coolify.services.values()][0].started = true;
      const second = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.deepEqual(second.ran, ["ready"]);
      assert.equal(second.boxReady, true);
      assert.equal(store.getTenant("acme").boxReady, true);
      assert.equal(store.getTenant("acme").status, "running");
    }, { coolify });
  } finally { await coolify.close(); }
});

test("the box answering for itself beats Coolify's opinion of it", async () => {
  const asked = [];
  const verdict = await waitForBox({
    client: { getService: async () => { asked.push("coolify"); return { status: "exited", applications: [] }; } },
    uuid: "svc-1",
    gateway: "http://titanbot-box-svc-1:1340",
    token: "a-token",
    probeImpl: async (url, init) => { asked.push(`${url} ${init.headers.authorization}`); return { status: 401 }; },
    timeoutMs: 1_000,
    intervalMs: 10,
  });
  // A 401 is an answer: something is listening on that port, which is the question being asked.
  assert.equal(verdict.ready, true);
  assert.equal(verdict.how, "gateway");
  assert.deepEqual(asked, ["http://titanbot-box-svc-1:1340/api/health Bearer a-token"]);
});

test("with no box to probe the wait falls back to Coolify and then gives up in words", async () => {
  const slept = [];
  const verdict = await waitForBox({
    client: { getService: async () => ({ status: "exited", applications: [] }) },
    uuid: "svc-1",
    gateway: "http://titanbot-box-svc-1:1340",
    probeImpl: () => { throw new Error("no such host"); },
    timeoutMs: 100,
    intervalMs: 20,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.how, "timeout");
  assert.match(verdict.reason, /Coolify says this box is stopped/);
  assert.ok(slept.length >= 3, "it really did wait between tries");
});

test("provisioning writes the tenant's directories and its gateway token, and no second password", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "console.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);
      const paths = tenantPaths("acme", config);

      for (const directory of tenantDirectoryList("acme", config)) assert.equal(existsSync(directory), true, `${directory} should exist`);

      // The shape the relay reads: {"token": "<64 hex>"} at 0600.
      const profile = JSON.parse(readFileSync(paths.profileTokenFile, "utf8"));
      assert.match(profile.token, /^[0-9a-f]{64}$/);
      assert.equal(((await stat(paths.profileTokenFile)).mode & 0o777), 0o600);

      // NO auth.json. There is one relay with one operator password, so a per-tenant one opened
      // nothing: a credential on disk that looks like a second door and is not one is worse than no
      // credential at all.
      assert.equal(existsSync(path.join(paths.state, "auth.json")), false, "a tenant is handed no password that opens nothing");
      assert.equal(paths.authFile, undefined);
      assert.equal(result.relayPassword, undefined);
      assert.equal(JSON.stringify(result).toLowerCase().includes("password"), false);

      // The token is never in the ledger.
      const ledger = JSON.stringify(store.listSteps("acme"));
      assert.equal(ledger.includes(profile.token), false);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("a failure stops at that step, says so on the tenant, and the retry starts there", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "console.titanium.bot" });
      coolify.failOnce("POST /services/{uuid}/envs", 500, "the environment store is unavailable");

      const first = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", probeImpl: noGateway });
      assert.equal(first.ok, false);
      assert.equal(first.step, "envs");
      assert.match(first.error, /500/);
      const failed = store.getTenant("acme");
      assert.equal(failed.status, "failed");
      assert.match(failed.lastError, /the environment store is unavailable/);
      const uuidAfterFailure = failed.coolifyServiceUuid;
      assert.match(uuidAfterFailure, /^svc-/, "the service it did create is remembered");
      const paths = tenantPaths("acme", config);
      const tokenAfterFailure = JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token;

      const second = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing", probeImpl: noGateway });
      assert.equal(second.ok, true, second.error);
      // Only the steps from the failure onwards.
      assert.deepEqual(second.ran, ["envs", "start", "ready"]);
      // One service, not two: a retry that created a second stack would leave a customer paying for
      // an instance nothing points at.
      assert.equal(coolify.callsTo("POST /services").length, 1);
      assert.equal(store.getTenant("acme").coolifyServiceUuid, uuidAfterFailure);
      // And the same gateway token, because a second one would leave the box authenticating with the
      // first and the relay presenting the second.
      assert.equal(JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token, tokenAfterFailure);
      assert.equal(store.getTenant("acme").status, "running");
      assert.equal(store.getTenant("acme").lastError, null);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("a failure at the very first Coolify call leaves nothing on Coolify and a retry starts it", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme", host: "console.titanium.bot" });
      coolify.failOnce("POST /services", 422, "environment_uuid is required");
      const first = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(first.ok, false);
      assert.equal(first.step, "service");
      assert.equal(store.getTenant("acme").coolifyServiceUuid, null);

      const second = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(second.ok, true, second.error);
      assert.deepEqual(second.ran, ["service", "envs", "start", "ready"]);
      assert.equal(coolify.callsTo("POST /services").length, 2);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("with no Coolify configured the run fails on the service step and says what to set", async () => {
  await withWorld(async ({ config, store }) => {
    store.createTenant({ slug: "acme", name: "Acme", host: "console.titanium.bot" });
    const result = await provisionTenant({ store, config, slug: "acme", name: "Acme" });
    assert.equal(result.ok, false);
    assert.equal(result.step, "service");
    assert.match(result.error, /CP_COOLIFY_URL and COOLIFY_API_KEY/);
  });
});

test("the Coolify API key is only ever an Authorization header", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme", host: "console.titanium.bot" });
      await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      for (const call of coolify.calls) {
        assert.equal(call.authorized, true);
        assert.equal(call.path.includes(coolify.apiKey), false);
        assert.equal(JSON.stringify(call.query).includes(coolify.apiKey), false);
        assert.equal(JSON.stringify(call.body ?? {}).includes(coolify.apiKey), false);
      }
      assert.equal(JSON.stringify(store.listSteps("acme")).includes(coolify.apiKey), false);
    }, { coolify });
  } finally { await coolify.close(); }
});

// ---- reading the state back ----------------------------------------------------------------------------

test("the live status reads the container rows, in the vocabulary Coolify writes them in", () => {
  assert.equal(coolifyStatusOf([{ status: "running (healthy)" }, { status: "running" }]), "running");
  assert.equal(coolifyStatusOf([{ status: "exited (0)" }, { status: "exited (137)" }]), "stopped");
  assert.equal(coolifyStatusOf([{ status: "running (healthy)" }, { status: "exited (0)" }]), "provisioning");
  assert.equal(coolifyStatusOf([]), "unknown");
  assert.equal(coolifyStatusOf(null), "unknown");
  assert.equal(coolifyStatusOf([{}]), "unknown");
});

// The next three are the shape the R750's Coolify 4.0.0 really answers with, measured 2026-09-07,
// which is not the shape its own openapi documents. GET /services/{uuid}/applications is a 404 on
// that build; GET /services/{uuid} carries a service-level `status` and an inline `applications`
// array instead. Reading only the documented sub-route is how a running tenant reads as "unknown".
test("the live state reads the applications the service object carries inline", async () => {
  const calls = [];
  const client = {
    getService: async (uuid) => {
      calls.push(`GET /services/${uuid}`);
      return {
        name: "titanbot",
        status: "running:unknown",
        server_status: true,
        applications: [
          { uuid: "afndip4rpuc371jjdk9m97kl", name: "titanbot-relay", fqdn: "https://console.titanium.bot:7777", status: "running:unknown" },
          { uuid: "boxuuid0000000000000000", name: "titanbot-box", fqdn: null, status: "running:healthy" },
        ],
      };
    },
    getServiceApplications: async () => { throw new Error("Not found."); },
  };
  const state = await readCoolifyState("p927bfqm83ioloibamlvyd7g", client);
  assert.equal(state.reachable, true);
  assert.equal(state.status, "running");
  assert.equal(state.name, "titanbot");
  assert.equal(state.containers.length, 2);
  assert.deepEqual(state.containers.map((c) => c.name).sort(), ["titanbot-box", "titanbot-relay"]);
  assert.equal(calls.length, 1, "the sub-route is not asked when the service object already answered");
});

test("a service object with no applications falls back to its own status line", async () => {
  const client = {
    getService: async () => ({ name: "titanbot", status: "exited", applications: [] }),
    getServiceApplications: async () => { throw new Error("Not found."); },
  };
  const state = await readCoolifyState("some-uuid", client);
  assert.equal(state.status, "stopped");
  assert.deepEqual(state.containers, []);
});

test("a Coolify that does have the documented sub-route is still read", async () => {
  const client = {
    getService: async () => ({ name: "titanbot" }),
    getServiceApplications: async () => ([{ name: "titanbot-relay", status: "running:healthy", fqdn: null }]),
  };
  const state = await readCoolifyState("some-uuid", client);
  assert.equal(state.status, "running");
  assert.equal(state.containers[0].name, "titanbot-relay");
});

// The two tests that were here were about a hostname Coolify still held for a tenant deleted
// moments ago, and the one 409 that was worth overriding. Both are gone with the urls step: a
// tenant is not given a hostname at all, so there is no domain to conflict with. What replaces them
// is the assertion that nothing asks for one.
test("nothing in a tenant's provisioning asks Coolify for a hostname", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);
      assert.equal(coolify.callsTo("PATCH /services/{uuid}").length, 0);
      for (const call of coolify.calls) {
        assert.equal(JSON.stringify(call.body ?? {}).includes("urls"), false);
        assert.equal(JSON.stringify(call.body ?? {}).includes("acme.titanium.bot"), false);
      }
      const stored = [...coolify.services.values()][0];
      assert.deepEqual(stored.urls, [], "a customer's box is never published");
    }, { coolify });
  } finally { await coolify.close(); }
});

// ---- the eighth step, PROXY-1 -------------------------------------------------------------------

test("the proxy key step runs for a workspace whose other seven steps are already done", async () => {
  // This is the shape both live customers are in on the R750: built before the proxy existed, so
  // every older step is marked ok and completedSteps skips all of them. If proxy-key were not a
  // step of its own it would never run for demo or richard-avery, and the migration would have
  // nothing to point their boxes at.
  const coolify = await startFakeCoolify();
  const proxy = await startFakeProxy();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme", host: "console.titanium.bot" });
      // The directories and the gateway token this workspace already has, because a workspace that
      // was built before the proxy existed has both on the disk.
      for (const directory of tenantDirectoryList("acme", config)) mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const step of ["directories", "secrets", "compose", "service", "envs", "start", "ready"]) {
        store.recordStep({ slug: "acme", step, status: "ok", detail: "{}" });
      }
      store.updateTenant("acme", { coolifyServiceUuid: "svc-acme", boxContainer: "titanbot-box-svc-acme" });

      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.ran, ["proxy-key"], "the only step left to run was the new one");
      assert.equal(proxy.callsTo("POST /key/generate").length, 1);

      // What the ledger keeps is the alias, the id and the file. Never the key.
      const step = store.listSteps("acme").find((one) => one.step === "proxy-key" && one.status === "ok");
      const record = readProxyKey("acme", config);
      assert.equal(JSON.parse(step.detail).alias, "titanbot-acme");
      assert.equal(step.detail.includes(record.key), false, "the provisioning ledger carried a live key");

      // And the retry is a READ. A second key would leave the box on the first one and the registry
      // handing out the second, which is a 401 with nothing anywhere to explain it.
      store.recordStep({ slug: "acme", step: "proxy-key", status: "failed", detail: "pretend it failed" });
      const again = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(again.ok, true, again.error);
      assert.equal(proxy.callsTo("POST /key/generate").length, 1, "a retry minted a second key");
      assert.equal(readProxyKey("acme", config).key, record.key);
    }, { coolify, env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); await coolify.close(); }
});

test("a proxy that will not mint fails the workspace at that step and leaves the rest standing", async () => {
  const coolify = await startFakeCoolify();
  const proxy = await startFakeProxy();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme", host: "console.titanium.bot" });
      proxy.failOnce("POST /key/generate", 503, "the proxy database is not up");
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(result.ok, false);
      assert.equal(result.step, "proxy-key");
      // A workspace whose agents cannot reach a model is not a workspace, so this is a stop and not
      // a warning. The container and the directories are already built, so the retry is cheap.
      assert.equal(store.getTenant("acme").status, "failed");
      assert.equal(store.completedSteps("acme").has("service"), true, "the earlier steps were thrown away");

      const retried = await provisionTenant({ store, config, slug: "acme", name: "Acme", probeImpl: noGateway });
      assert.equal(retried.ok, true, retried.error);
      assert.deepEqual(retried.ran, ["proxy-key", "start", "ready"]);
      assert.equal(coolify.callsTo("POST /services").length, 1, "the retry built a second box");
    }, { coolify, env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); await coolify.close(); }
});


// TENANT-8 / CURSOR-1 item 5. A new tenant's box starts with settings of its own.
//
// MEASURED ON THE R750 2026-09-08: gates.json was missing from all three tenant data directories
// (/data/titanbot/{demo,richard-avery,north-bay-roofing}/volumes/data), so every tenant box fell
// through to whatever the bundled gate table happened to be. That file carries sand_auto_review:
// false and the rest of the CURSOR-1 pins, which is the whole reason the row exists.
test("a new tenant's data directory gets the box defaults, at 0600", async () => {
  const root = await makeTempRoot("cp-defaults-");
  try {
    const data = path.join(root, "volumes", "data");
    const result = writeBoxDefaults(data);
    assert.equal(result.missingDefaults, false, "deploy/box-defaults is not in this checkout");
    assert.deepEqual(result.written, boxDefaultNames());
    assert.deepEqual(result.skipped, []);
    assert.ok(result.written.includes("gates.json"), "gates.json is the file the row is about");
    for (const name of result.written) {
      const target = path.join(data, name);
      assert.equal(existsSync(target), true, `${name} was reported written and is not there`);
      assert.equal(((await stat(target)).mode & 0o777).toString(8), "600",
        `${name} is more readable than box-secrets.json beside it`);
      JSON.parse(readFileSync(target, "utf8"));
    }
    assert.equal(JSON.parse(readFileSync(path.join(data, "gates.json"), "utf8")).sand_auto_review, false,
      "the CURSOR-1 pin is not in the file that was written");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The retry case. The directories step is re-run from wherever a provision failed, and an operator
// may have flipped a switch since the box was built. A default is what a box starts with, not what
// it is held to.
test("a retry does not overwrite a switch an operator has already edited", async () => {
  const root = await makeTempRoot("cp-defaults-retry-");
  try {
    const data = path.join(root, "volumes", "data");
    mkdirSync(data, { recursive: true });
    const edited = JSON.stringify({ sand_auto_review: true, edited_by_hand: true }, null, 2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(data, "gates.json"), edited, "utf8");

    const result = writeBoxDefaults(data);
    assert.deepEqual(result.skipped, ["gates.json"], "the edited file was not reported as skipped");
    assert.equal(result.written.includes("gates.json"), false, "the edit was overwritten by the default");
    assert.equal(readFileSync(path.join(data, "gates.json"), "utf8"), edited,
      "an operator's edit did not survive a retry of the directories step");
    // And the file that was NOT there still arrives, so a partial directory is completed rather
    // than left as it was found.
    assert.ok(result.written.includes("sand-host-settings.json"));

    // Idempotent: a third run writes nothing at all and says so.
    const again = writeBoxDefaults(data);
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.skipped, boxDefaultNames());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a checkout with no defaults directory provisions instead of failing", async () => {
  const root = await makeTempRoot("cp-defaults-absent-");
  try {
    const data = path.join(root, "volumes", "data");
    const result = writeBoxDefaults(data, { defaultsDir: path.join(root, "nowhere") });
    assert.equal(result.missingDefaults, true);
    assert.deepEqual(result.written, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
