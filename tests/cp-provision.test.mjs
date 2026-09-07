// TENANT-1. Provisioning: the slug rules, the compose the tenant gets, the dry run that creates
// nothing, a full run against a fake Coolify that answers the way the openapi says, and the retry
// that picks up at the step that failed instead of building a second half-instance.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { readAuthFile, verifyPassword as verifyRelayPassword } from "../ui/auth.mjs";
import {
  BASE_COMPOSE_PATH,
  RESERVED_SLUGS,
  coolifyStatusOf,
  loadConfig,
  readCoolifyState,
  provisionTenant,
  renderCompose,
  tenantDirectoryList,
  tenantPaths,
  validateSlug,
} from "../cp/provision.mjs";
import { tenantSessionSecret } from "../cp/session.mjs";
import { openStore } from "../cp/store.mjs";
import { makeTempRoot, startFakeCoolify } from "./cp-support.mjs";

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
    ...(options.env ?? {}),
  });
  const store = openStore({ dataDir: config.dataDir });
  try { await run({ config, store, root }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

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

// ---- the compose ----------------------------------------------------------------------------------

test("the rendered compose points at this tenant's own directories and nobody else's", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderCompose({ slug: "acme", config });
    const paths = tenantPaths("acme", config);

    // The four data mounts, off the shared docker volumes and onto this tenant's tree.
    assert.match(rendered, new RegExp(`- ${paths.workspace}:/workspace`));
    assert.match(rendered, new RegExp(`- ${paths.data}:/home/box/sand-data`));
    assert.match(rendered, new RegExp(`- ${paths.store}:/var/lib/sand-box-store`));
    assert.match(rendered, new RegExp(`- ${paths.chrome}:/home/box/chrome-profile`));
    assert.equal(rendered.includes("/data/docker/volumes/titanbot-box-"), false, "no tenant may point at the shared docker volumes");

    // Per tenant: the gateway token file and the credential placeholder.
    assert.match(rendered, new RegExp(`- ${paths.profile}:/profile`));
    assert.match(rendered, new RegExp(`- ${paths.credential}:/run/grok-bot:ro`));

    // Shared by every tenant: one copy of the release on the host, so an update is one ship.
    assert.match(rendered, /- \/home\/sem\/titanbot\/runtime:\/opt\/titanbot-runtime:ro/);
    assert.match(rendered, /- \/home\/sem\/titanbot\/deploy:\/init:ro/);
    // READ-ONLY, and this is the operator's own console directory: endpoints.json in it holds the
    // provider API keys, and read-write it was a second customer's to overwrite.
    assert.match(rendered, /- \/home\/sem\/titanbot\/ui:\/app\/ui:ro/);
    assert.equal(/- \/home\/sem\/titanbot\/ui:\/app\/ui$/m.test(rendered), false, "no writable copy of that mount is left behind");

    // The tenant's own writable corner, and every store the relay takes from the environment
    // pointed into it.
    assert.match(rendered, new RegExp(`- ${paths.state}:/state`));
    assert.match(rendered, /SAND_UI_STATE_DIR: \/state/);
    assert.match(rendered, /SAND_UI_AUTH_FILE: \/state\/auth\.json/);
    assert.match(rendered, /GROK_BOT_SUBSCRIPTIONS_FILE: \/state\/subscriptions\.json/);
    assert.match(rendered, /GROK_BOT_MAIL_FILE: \/state\/mail\.json/);
    assert.match(rendered, /GROK_BOT_MAIL_LEDGER_FILE: \/state\/mail-inbox\.jsonl/);
    assert.match(rendered, /SAND_UI_ENDPOINTS_FILE: \/state\/endpoints\.json/);
  });
});

test("no tenant gets the docker socket, because a socket in that container is root on the host", async () => {
  await withWorld(async ({ config }) => {
    const base = readFileSync(BASE_COMPOSE_PATH, "utf8");
    // The operator's own stack does mount it, which is what makes the removal worth asserting.
    assert.match(base, /^ {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);

    const rendered = renderCompose({ slug: "acme", config });
    assert.equal(
      /^ {6}- .*docker\.sock/m.test(rendered),
      false,
      "a tenant relay with the host socket is root on the R750 and holds every other customer's files",
    );
    assert.match(rendered, /NO DOCKER SOCKET/);

    // And the renderer refuses to guess: if the line it removes ever moves, rendering stops rather
    // than quietly shipping a tenant that still has it.
    const moved = base.replace("      - /var/run/docker.sock:/var/run/docker.sock", "      - /var/run/docker.sock:/var/run/docker.sock:ro");
    assert.throws(() => renderCompose({ slug: "acme", config, composeText: moved }), /no longer has the line/);
  });
});

test("the tenant's Coolify environment gets its own session key, never the master", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme" });
      assert.equal(result.ok, true, result.error);

      const sent = coolify.callsTo("POST /services/{uuid}/envs").find((call) => call.body.key === "CP_SESSION_SECRET");
      assert.equal(sent.body.value, tenantSessionSecret(config.sessionSecret, "acme"));
      assert.notEqual(sent.body.value, config.sessionSecret, "the master signs for every tenant and is never handed to one");
      // A key for a different tenant is a different value, so what acme holds cannot sign for
      // titanium even though acme can read it out of its own container.
      assert.notEqual(sent.body.value, tenantSessionSecret(config.sessionSecret, "titanium"));
    }, { coolify });
  } finally { await coolify.close(); }
});

test("the rendered compose names the tenant and the control plane", async () => {
  await withWorld(async ({ config }) => {
    const rendered = renderCompose({ slug: "acme", config });
    // Once on the box and once on the relay.
    assert.equal(rendered.split("TENANT_ID: acme").length - 1, 2);
    assert.match(rendered, /CP_URL: https:\/\/api\.titanium\.bot/);
    assert.match(rendered, /CP_SESSION_SECRET: \$\{CP_SESSION_SECRET\}/);
    assert.match(rendered, /SAND_GATEWAY_TOKEN: \$\{TITANBOT_GATEWAY_TOKEN\}/);
    assert.match(rendered, /^# Rendered for tenant "acme"/);
    assert.match(rendered, /console       https:\/\/acme\.titanium\.bot/);
  });
});

test("no secret of any kind is in the compose text", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "acme.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing" });
      assert.equal(result.ok, true, result.error);

      const paths = tenantPaths("acme", config);
      const gatewayToken = JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token;
      const authRecord = readAuthFile(paths.authFile);
      const rendered = renderCompose({ slug: "acme", config });

      assert.equal(rendered.includes(gatewayToken), false, "the gateway token is a Coolify env, never compose text");
      assert.equal(rendered.includes(result.relayPassword), false, "the relay password is never written anywhere but the hash");
      assert.equal(rendered.includes(config.sessionSecret), false, "the session secret is a Coolify env, never compose text");
      assert.equal(rendered.includes(authRecord.password.hash), false);
      assert.equal(rendered.includes(authRecord.cookieSecret), false);

      // The same is true of what Coolify was handed: the compose it stores carries references only.
      const created = coolify.callsTo("POST /services")[0];
      const stored = Buffer.from(created.body.docker_compose_raw, "base64").toString("utf8");
      assert.equal(stored.includes(gatewayToken), false);
      assert.equal(stored.includes(config.sessionSecret), false);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("rendering refuses to guess when the base compose has moved underneath it", async () => {
  await withWorld(async ({ config }) => {
    const withoutTheAnchor = readFileSync(BASE_COMPOSE_PATH, "utf8")
      .replace('      SAND_UI_PORT: "7777"', '      SAND_UI_PORT: "8888"');
    assert.throws(
      () => renderCompose({ slug: "acme", config, composeText: withoutTheAnchor }),
      /no longer has the line/,
    );
    const withoutTheVolume = readFileSync(BASE_COMPOSE_PATH, "utf8")
      .replace("/data/docker/volumes/titanbot-box-chrome/_data", "/somewhere/else");
    assert.throws(() => renderCompose({ slug: "acme", config, composeText: withoutTheVolume }), /no longer mounts/);
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
      assert.deepEqual(result.plan.steps.map((step) => step.name), ["directories", "secrets", "compose", "service", "envs", "urls", "start"]);
      assert.equal(result.plan.steps[3].method, "POST");
      assert.equal(result.plan.steps[3].path, "/services");
      assert.equal(result.plan.steps[3].bodyPreview.name, "titanbot-acme");
      assert.equal(result.plan.steps[3].bodyPreview.project_uuid, "project-uuid-1");
      assert.equal(result.plan.steps[3].bodyPreview.server_uuid, "server-uuid-1");
      assert.equal(result.plan.steps[3].bodyPreview.environment_name, "production");
      assert.equal(result.plan.steps[3].bodyPreview.instant_deploy, false);
      assert.equal(result.plan.steps[5].bodyPreview.urls[0].url, "https://acme.titanium.bot:7777");
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
    assert.deepEqual(envs.bodyPreview.keys, ["TITANBOT_GATEWAY_TOKEN", "CP_SESSION_SECRET"]);
    assert.equal(envs.bodyPreview.values, "(set)");
    const text = JSON.stringify(result.plan);
    assert.equal(text.includes(SESSION_SECRET), false);
  });
});

// ---- a real run --------------------------------------------------------------------------------------

test("provisioning walks the seven steps and calls Coolify the way the openapi documents", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "acme.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing" });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.ran, ["directories", "secrets", "compose", "service", "envs", "urls", "start"]);

      // Two POSTs that each answer 409 and two PATCHes behind them. Coolify makes an empty field
      // for every ${VAR} the compose names as soon as the service exists, so the fields these two
      // keys go in are already there and only a PATCH fills them. The POST goes first anyway
      // because a retry of a half-finished provision can find them missing.
      assert.deepEqual(coolify.routes(), [
        "POST /services",
        "POST /services/{uuid}/envs",
        "PATCH /services/{uuid}/envs",
        "POST /services/{uuid}/envs",
        "PATCH /services/{uuid}/envs",
        "PATCH /services/{uuid}",
        "POST /services/{uuid}/start",
      ]);
      // And the values did land, which is the thing the 409 hid on the R750.
      const stored = [...coolify.services.values()][0].envs;
      for (const key of ["TITANBOT_GATEWAY_TOKEN", "CP_SESSION_SECRET"]) {
        const entry = stored.find((one) => one.key === key);
        assert.ok(entry != null && String(entry.value).length > 0, `${key} was left empty`);
      }

      const created = coolify.callsTo("POST /services")[0];
      assert.equal(created.authorized, true);
      assert.equal(created.body.name, "titanbot-acme");
      assert.equal(created.body.project_uuid, "project-uuid-1");
      assert.equal(created.body.environment_name, "production");
      assert.equal(created.body.server_uuid, "server-uuid-1");
      assert.equal(created.body.instant_deploy, false);
      assert.match(Buffer.from(created.body.docker_compose_raw, "base64").toString("utf8"), /TENANT_ID: acme/);

      const envs = coolify.callsTo("POST /services/{uuid}/envs").map((call) => call.body.key);
      assert.deepEqual(envs, ["TITANBOT_GATEWAY_TOKEN", "CP_SESSION_SECRET"]);
      const patched = coolify.callsTo("PATCH /services/{uuid}")[0];
      assert.deepEqual(patched.body.urls, [{ name: "titanbot-relay", url: "https://acme.titanium.bot:7777" }]);

      const tenant = store.getTenant("acme");
      assert.match(tenant.coolifyServiceUuid, /^svc-/);
      assert.equal(tenant.status, "provisioning", "Coolify queues the start, so nothing is running yet");
      assert.equal(tenant.lastError, null);
      assert.deepEqual(store.listSteps("acme").map((step) => `${step.step}:${step.status}`), [
        "directories:ok", "secrets:ok", "compose:ok", "service:ok", "envs:ok", "urls:ok", "start:ok",
      ]);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("provisioning writes the tenant's directories, its gateway token and its relay password", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "acme.titanium.bot" });
      const result = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing" });
      assert.equal(result.ok, true, result.error);
      const paths = tenantPaths("acme", config);

      for (const directory of tenantDirectoryList("acme", config)) assert.equal(existsSync(directory), true, `${directory} should exist`);

      // The shape ui/server.mjs tokenFromProfile reads: {"token": "<64 hex>"} at 0600.
      const profile = JSON.parse(readFileSync(paths.profileTokenFile, "utf8"));
      assert.match(profile.token, /^[0-9a-f]{64}$/);
      assert.equal(((await stat(paths.profileTokenFile)).mode & 0o777), 0o600);

      // The auth record the relay reads at boot, written by the relay's own routine so it cannot
      // drift, and it verifies against the password the operator was handed.
      const record = readAuthFile(paths.authFile);
      assert.equal(record.version, 1);
      assert.equal(record.password.algorithm, "scrypt");
      assert.equal(record.password.N, 16384);
      assert.equal(record.cookieSecret.length, 64);
      assert.equal(((await stat(paths.authFile)).mode & 0o777), 0o600);
      assert.equal(verifyRelayPassword(result.relayPassword, record.password), true);
      assert.equal(verifyRelayPassword("not-the-password", record.password), false);

      // Handed back once, and the ledger never sees it.
      assert.equal(result.relayPassword.length >= 32, true);
      const ledger = JSON.stringify(store.listSteps("acme"));
      assert.equal(ledger.includes(result.relayPassword), false);
      assert.equal(ledger.includes(profile.token), false);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("a failure stops at that step, says so on the tenant, and the retry starts there", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme Roofing", host: "acme.titanium.bot" });
      coolify.failOnce("POST /services/{uuid}/envs", 500, "the environment store is unavailable");

      const first = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing" });
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

      const second = await provisionTenant({ store, config, slug: "acme", name: "Acme Roofing" });
      assert.equal(second.ok, true, second.error);
      // Only the steps from the failure onwards.
      assert.deepEqual(second.ran, ["envs", "urls", "start"]);
      // One service, not two: a retry that created a second stack would leave a customer paying for
      // an instance nothing points at.
      assert.equal(coolify.callsTo("POST /services").length, 1);
      assert.equal(store.getTenant("acme").coolifyServiceUuid, uuidAfterFailure);
      // And the same gateway token, because a second one would leave the box authenticating with the
      // first and the relay presenting the second.
      assert.equal(JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token, tokenAfterFailure);
      // The relay password was set on the first run and cannot be shown again, and the note says so
      // in words rather than leaving a null to puzzle over.
      assert.equal(second.relayPassword, null);
      assert.match(second.relayPasswordNote, /set on an earlier run/);
      assert.equal(store.getTenant("acme").status, "provisioning");
      assert.equal(store.getTenant("acme").lastError, null);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("a failure at the very first Coolify call leaves nothing on Coolify and a retry starts it", async () => {
  const coolify = await startFakeCoolify();
  try {
    await withWorld(async ({ config, store }) => {
      store.createTenant({ slug: "acme", name: "Acme", host: "acme.titanium.bot" });
      coolify.failOnce("POST /services", 422, "environment_uuid is required");
      const first = await provisionTenant({ store, config, slug: "acme", name: "Acme" });
      assert.equal(first.ok, false);
      assert.equal(first.step, "service");
      assert.equal(store.getTenant("acme").coolifyServiceUuid, null);

      const second = await provisionTenant({ store, config, slug: "acme", name: "Acme" });
      assert.equal(second.ok, true, second.error);
      assert.deepEqual(second.ran, ["service", "envs", "urls", "start"]);
      assert.equal(coolify.callsTo("POST /services").length, 2);
    }, { coolify });
  } finally { await coolify.close(); }
});

test("with no Coolify configured the run fails on the service step and says what to set", async () => {
  await withWorld(async ({ config, store }) => {
    store.createTenant({ slug: "acme", name: "Acme", host: "acme.titanium.bot" });
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
      store.createTenant({ slug: "acme", name: "Acme", host: "acme.titanium.bot" });
      await provisionTenant({ store, config, slug: "acme", name: "Acme" });
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
