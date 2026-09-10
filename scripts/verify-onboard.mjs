#!/usr/bin/env node
// verify-onboard.mjs -- ONBOARD-2, measured against a control plane from the repo and nothing real.
//
// Two arms.
//
//   --remove-only   REMOVING a customer, driven straight at cp/decommission.mjs. Needs nothing but
//                   this repo: a fake Coolify, a fake relay and a temporary store. This is item C's
//                   own gate, and it is the arm that proves the thing the whole design turns on --
//                   that a Coolify 200 is not a removed container.
//
//   (no flag)       The whole sequence as well: Add a client answering 202 with the temporary
//                   password, five steps going green in order, the sweep, the welcome captured by a
//                   stub Resend, the sign-in link exercised and then dropped, and the removal
//                   leaving nothing. Those legs go over POST /v1/admin/clients and its onboarding
//                   poll. When that route is not the job-shaped one yet they report NOT MEASURED
//                   with the reason, so this file runs green today and measures the whole wave on
//                   the merged tip.
//
// NOTHING HERE TOUCHES A NETWORK. The Coolify, the relay, the Resend and the box are all in this
// process. api.resend.com is never called by anything repeatable; the one real send in this wave is
// the R750 measurement and it is not this file.
//
// THE SIGN-IN LINK IS NEVER WRITTEN DOWN. It is read out of the captured mail, exercised against the
// stub relay's /login?sso=, and dropped. It is a stateless bearer with no revocation, so it does not
// go into a file, a log line, a screenshot or this gate's own output.
//
// Exit 0 nothing failed, 1 a check failed, 2 nothing could be measured.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { createDecommission, REFUSALS } from "../cp/decommission.mjs";
import {
  boxContainerName, createCoolifyClient, createRelayAsk, deriveSlug, loadConfig, tenantDirectory, waitForBox,
} from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";
import { makeTempRoot, startControlPlane, startFakeCoolify, startFakeRelay } from "../tests/cp-support.mjs";
import { gateUserAgent } from "./gate-agent.mjs";

// SIGNIN-1. Derived from this file's own name rather than typed, so a rename cannot leave the header
// lying. Nothing this gate touches is a live login door (the sso link is exercised against a fake
// relay on 127.0.0.1), and tests/gate-agent.test.mjs records that with the reason.
const UA = gateUserAgent(import.meta.url);
const argv = new Set(process.argv.slice(2));
const REMOVE_ONLY = argv.has("--remove-only");

let passes = 0;
let failures = 0;
let notMeasured = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (ok) passes += 1; else failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} -- ${why}`); notMeasured += 1; };
const step = (name) => console.log(`\n== ${name}`);
const info = (line) => console.log(`  INFO  ${line}`);

/** A check whose body may throw. The throw IS the failure and its message is the detail. */
const checking = async (label, body) => {
  try { const detail = await body(); check(true, label, typeof detail === "string" ? detail : ""); }
  catch (error) { check(false, label, String(error?.message ?? error).split("\n")[0].slice(0, 300)); }
};

// ---- the world ----------------------------------------------------------------------------------

async function makeWorld(options = {}) {
  const root = await makeTempRoot("verify-onboard-");
  const coolify = await startFakeCoolify();
  const relay = await startFakeRelay({ coolify, ...(options.relay ?? {}) });
  const config = loadConfig({
    CP_DATA_DIR: path.join(root, "data"),
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: path.join(root, "release"),
    CP_BASE_DOMAIN: "titanium.bot",
    COOLIFY_URL: coolify.url,
    COOLIFY_API_KEY: coolify.apiKey,
    COOLIFY_PROJECT_UUID: "project-uuid",
    COOLIFY_SERVER_UUID: "server-uuid",
    CP_RELAY_URL: relay.url,
    CP_RELAY_TOKEN: relay.token,
    CP_ALLOW_NEW_TENANTS: "1",
  });
  const store = openStore({ dataDir: config.dataDir });
  const client = createCoolifyClient({ config });
  const askRelayPost = createRelayAsk({ config, timeoutMs: 4_000 });
  return {
    root, config, store, client, coolify, relay, askRelayPost,
    async dispose() {
      store.close();
      await relay.close();
      await coolify.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One customer, built the way provisioning builds one, without the eight-step wait. */
async function makeCustomer(world, options = {}) {
  const slug = options.slug ?? "acme-roofing";
  const created = await world.client.createService({ name: `titanbot-${slug}`, docker_compose_raw: "services:\n  titanbot-box:\n    image: x\n" });
  await world.client.startService(created.uuid);
  const container = boxContainerName(created.uuid);
  world.store.createTenant({ slug, name: options.name ?? "Acme Roofing", host: "console.titanium.bot", status: "running", ownerEmail: options.email ?? "jane@acme.test" });
  world.store.updateTenant(slug, { coolifyServiceUuid: created.uuid, boxContainer: container, boxReady: true });
  world.store.createAccount({ email: options.email ?? "jane@acme.test", password: "a-long-enough-password", name: "Jane", tenant: slug });
  const titan = world.store.mintMailCode({ tenant: slug, agentId: "titan-1", agentName: "Titan", domain: "myagents.email" });
  const dataPath = tenantDirectory(slug, world.config);
  mkdirSync(path.join(dataPath, "volumes", "data"), { recursive: true });
  writeFileSync(path.join(dataPath, "volumes", "data", "settings.json"), "{}");
  world.relay.names.set(slug, container);
  world.relay.data.set(slug, { path: dataPath, bytes: 6_200_000 });
  return { slug, uuid: created.uuid, container, titan, dataPath };
}

function decommissionFor(world, options = {}) {
  const order = [];
  const client = {
    stopService: async (uuid) => { order.push("stop"); return world.client.stopService(uuid); },
    deleteService: async (uuid) => { order.push("delete"); return world.client.deleteService(uuid); },
    getService: async (uuid) => world.client.getService(uuid),
  };
  const proxy = options.proxy ?? {
    configured: true,
    async deleteKeyByAlias(slug) { order.push(`proxy:${slug}`); return { ok: true, alias: `titanbot-${slug}` }; },
  };
  return {
    order,
    decommission: createDecommission({
      store: world.store, config: world.config, client, proxy,
      askRelayPost: world.askRelayPost, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(25, ms))),
      ...(options.deps ?? {}),
    }),
  };
}

// ---- the removal arm ----------------------------------------------------------------------------

async function removeArm() {
  step("the four refusals, and each has no effect at all");
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      const { decommission, order } = decommissionFor(world);

      await checking("an unknown workspace is refused, and Coolify is not called", async () => {
        const before = world.coolify.calls.length;
        const answer = await decommission.remove({ slug: "nobody-here", confirm: "nobody-here" });
        assert.equal(answer.status, "not_found");
        assert.equal(answer.message, REFUSALS.not_found("nobody-here"));
        assert.equal(world.coolify.calls.length, before);
        return answer.message;
      });

      await checking("a wrong confirm is refused, and nothing moves", async () => {
        const before = world.coolify.calls.length;
        const answer = await decommission.remove({ slug: built.slug, confirm: "acme" });
        assert.equal(answer.status, "confirm_required");
        assert.equal(world.coolify.calls.length, before);
        assert.equal(world.store.getMailAddressByCode(built.titan.code).state, "active");
        return answer.message;
      });

      await checking("an adopted workspace is refused 409 and NOTHING is called on Coolify", async () => {
        world.store.recordStep({ slug: built.slug, step: "adopt", status: "ok", detail: "{}" });
        world.store.updateTenant(built.slug, { status: "stopped" });
        const before = world.coolify.calls.length;
        const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
        assert.equal(answer.status, "adopted");
        assert.equal(world.coolify.calls.length, before, "an adopted workspace reached Coolify");
        assert.deepEqual(order, [], "an adopted workspace reached the proxy or Coolify through the client");
        assert.equal(world.store.getTenant(built.slug) != null, true);
        return "a stop first does not walk around it: the guard reads the ledger, not the status column";
      });
    } finally { await world.dispose(); }
  }
  {
    const world = await makeWorld();
    try {
      await makeCustomer(world, { slug: "titanium", name: "Titanium Computing" });
      const { decommission, order } = decommissionFor(world);
      await checking("one of the product's own names is refused", async () => {
        const answer = await decommission.remove({ slug: "titanium", confirm: "titanium" });
        assert.equal(answer.status, "operator_slug");
        assert.deepEqual(order, []);
        return answer.message;
      });
    } finally { await world.dispose(); }
  }

  step("the effects, in the order the design writes them down");
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      const scribe = world.store.mintMailCode({ tenant: built.slug, agentId: "scribe-1", agentName: "Scribe", domain: "myagents.email" });
      const { decommission, order } = decommissionFor(world);
      const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, actor: "the gate" });

      await checking("the nine effects land in the documented order", async () => {
        assert.equal(answer.ok, true, answer.message);
        assert.deepEqual(answer.effects.map((effect) => effect.step),
          ["disable-signins", "addresses", "proxy-key", "stop", "service", "container-gone", "data", "accounts", "audit-ready"]);
        return answer.effects.map((effect) => effect.step).join(" > ");
      });
      await checking("the addresses are retired BEFORE the container goes", async () => {
        const at = (name) => answer.effects.findIndex((effect) => effect.step === name);
        assert.equal(at("addresses") < at("container-gone"), true);
        return "after the box is gone nothing would ever retire them: the sweep needs a roster it can read";
      });
      await checking("the proxy key is revoked BEFORE deleteService, proved by call order", async () => {
        assert.equal(order.indexOf(`proxy:${built.slug}`) < order.indexOf("delete"), true, order.join(" "));
        return order.join(" > ");
      });
      await checking("every active address for the workspace is retired", async () => {
        for (const code of [built.titan.code, scribe.code]) {
          assert.equal(world.store.getMailAddressByCode(code).state, "retired", `${code} is still active`);
        }
        return `${answer.addressesRetired.length} retired`;
      });
      await checking("docker_cleanup=false, delete_volumes=false, delete_connected_networks=true on the wire", async () => {
        const deletes = world.coolify.callsTo("DELETE /services/{uuid}");
        assert.equal(deletes.length, 1);
        assert.deepEqual(deletes[0].query, {
          delete_configurations: "true", delete_volumes: "false", docker_cleanup: "false", delete_connected_networks: "true",
        });
        return "one customer's removal never prunes the whole server";
      });
    } finally { await world.dispose(); }
  }

  step("the proof, which is the whole reason this exists");
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      world.coolify.neverRemoves = true;
      const { decommission } = decommissionFor(world);
      const answer = await decommission.remove({
        slug: built.slug, confirm: built.slug, deleteData: true, containerDeadlineMs: 400, pollMs: 40,
      });
      await checking("Coolify forgetting the service while the container runs is reported NOT ok", async () => {
        // The gate must FAIL to report success here. If this check ever passes by reading ok:true,
        // the product is claiming a removal over a live container holding a customer's gateway token.
        assert.equal(answer.ok, false, "the removal reported success over a running container");
        assert.equal(answer.status, "container_still_there");
        assert.equal(answer.provedBy, "");
        return answer.message.slice(0, 160);
      });
      await checking("it stops BEFORE the data step and the tenant row survives", async () => {
        const steps = answer.effects.map((effect) => effect.step);
        assert.equal(steps.includes("data"), false);
        assert.equal(steps.includes("accounts"), false);
        assert.equal(existsSync(built.dataPath), true, "the customer's data was touched");
        assert.equal(world.store.getTenant(built.slug) != null, true, "the tenant row was deleted anyway");
        return "the operator can see it and finish it";
      });
      await checking("the answer names the command that finishes the job", async () => {
        assert.match(answer.message, new RegExp(`docker rm -f ${built.container}`));
        return `docker rm -f ${built.container}`;
      });
    } finally { await world.dispose(); }
  }
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      world.coolify.deleteDelayMs = 150;
      const { decommission } = decommissionFor(world);
      const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, containerDeadlineMs: 8_000, pollMs: 40 });
      await checking("a delete whose remote half lands late is waited for, and the proof is named", async () => {
        assert.equal(answer.ok, true, answer.message);
        assert.equal(answer.provedBy, "docker");
        assert.equal(world.coolify.containerPresent(built.container), false);
        return `provedBy=docker after ${answer.tookMs} ms on this Mac`;
      });
    } finally { await world.dispose(); }
  }

  step("the data switch, and what the card is allowed to say");
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      const { decommission } = decommissionFor(world);
      const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: false });
      await checking("with the switch off the directory is untouched and the relay is never asked to delete", async () => {
        assert.equal(answer.dataDeleted, false);
        assert.equal(existsSync(built.dataPath), true);
        assert.equal(world.relay.callsTo("/tenant/purge").some((call) => call.body?.probeOnly !== true), false);
        return built.dataPath;
      });
      await checking("the sentence says the data is kept with nothing deleting it on a timer", async () => {
        assert.match(answer.message, /Nothing deletes it on a timer\./);
        assert.equal(/thirty days|30 days/i.test(answer.message), false, "the card claimed a retention nothing counts");
        return "there is no reaper in this product, and the card does not pretend there is (ONBOARD-4)";
      });
    } finally { await world.dispose(); }
  }
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      const { decommission } = decommissionFor(world);
      const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
      await checking("with the switch on the relay is asked, and it is never handed a path", async () => {
        assert.equal(answer.dataDeleted, true);
        const purges = world.relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
        assert.equal(purges.length, 1);
        assert.deepEqual(Object.keys(purges[0].body), ["slug"], "the control plane sent the relay a path");
        assert.equal(world.relay.data.has(built.slug), false);
        return `${answer.bytesFreed} bytes freed, the relay resolved the path from its own tenant root`;
      });
    } finally { await world.dispose(); }
  }

  step("what is left afterwards");
  {
    const world = await makeWorld();
    try {
      const built = await makeCustomer(world);
      world.store.createAccount({ email: "sam@acme.test", password: "a-long-enough-password", name: "Sam", tenant: built.slug });
      const { decommission } = decommissionFor(world);
      const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true, actor: "the gate" });
      await checking("no tenant row, no account, and the slug is NOT retired", async () => {
        assert.equal(answer.ok, true, answer.message);
        assert.equal(world.store.getTenant(built.slug), null);
        assert.equal(world.store.getAccountByEmail("jane@acme.test"), null);
        assert.equal(world.store.getAccountByEmail("sam@acme.test"), null);
        assert.equal(world.store.isSlugRetired(built.slug), false);
        return "deleteTenant, then deleteAccount for each, then releaseSlug -- the order is load-bearing";
      });
      await checking("a fresh add for the same company is offered the same name", async () => {
        const taken = (candidate) => world.store.getTenant(candidate) != null || world.store.isSlugRetired(candidate);
        const again = deriveSlug("Acme Roofing", taken);
        assert.equal(again, built.slug, `the name came back as ${again}`);
        return again;
      });
    } finally { await world.dispose(); }
  }

  step("the provisioning fixes this item ships alongside");
  await checking("the readiness probe asks /health and records the status it got", async () => {
    const asked = [];
    const verdict = await waitForBox({
      client: { getService: async () => ({ status: "exited", applications: [] }) },
      uuid: "svc-1",
      gateway: "http://titanbot-box-svc-1:1340",
      token: "a-token",
      probeImpl: async (url) => { asked.push(url); return { status: 200 }; },
      timeoutMs: 500, intervalMs: 10,
    });
    assert.equal(verdict.how, "gateway");
    assert.equal(verdict.status, 200);
    assert.deepEqual(asked, ["http://titanbot-box-svc-1:1340/health"]);
    return "the bundle does not serve /api/health (measured 404); the relay's own health proxy asks /health too";
  });
}

// ---- the whole-sequence arm ---------------------------------------------------------------------
//
// Everything here goes over POST /v1/admin/clients and its onboarding poll, which is item A. Each
// leg reports NOT MEASURED with the reason when that route is not the job-shaped one yet, so this
// file is green today and measures the wave on the merged tip.

/** A stub box, counting every gateway call it is asked for. A sendPrompt or a createAgent FAILS. */
async function startStubBox() {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const method = request.url.replace(/^\/api\//, "").replace(/\?.*$/, "");
      calls.push(method);
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (request.url === "/health") return send(200, { ok: true });
      if (method === "listAgents") return send(200, { agents: [{ id: "titan-1", name: "Titan", createdAt: 1 }] });
      // done:false, and the READ ITSELF is what writes it. On a fresh box the first read locks the
      // first run in, which is why the card doing it early is a feature and a prompt here would be a
      // catastrophe: onboarding-state.ts marks a box done for ever if it holds a prompted agent at
      // the first read, and resetOnboarding is 403 without SAND_TEST_HOOKS.
      if (method === "getOnboardingState") return send(200, { done: false, maxAgents: 40, answers: {} });
      return send(404, { error: "unknown gateway method" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

async function sequenceArm() {
  step("the invite, end to end");
  const coolify = await startFakeCoolify();
  const relay = await startFakeRelay({ coolify, sweepBusy: 1, modelLabel: "" });
  const box = await startStubBox();
  const cp = await startControlPlane({
    coolifyUrl: coolify.url,
    coolifyApiKey: coolify.apiKey,
    env: {
      CP_RELAY_URL: relay.url,
      CP_RELAY_TOKEN: relay.token,
      // The door item A needs so a gate can point the box reads at a stub. Named here so the
      // contract is written down whether or not it exists yet.
      CP_BOX_URL_OVERRIDE: box.url,
    },
  });
  const ask = (method, pathname, body) => fetch(`${cp.base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${cp.config.adminToken}`,
      accept: "application/json",
      "user-agent": UA,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

  try {
    const started = Date.now();
    const answer = await ask("POST", "/v1/admin/clients", {
      email: "owner@onboard.test", company: "Onboard Test Gate", name: "Onboard Test",
      welcome: true, welcomeTo: "gate@onboard.test", ceiling: 40,
    });
    const jobShaped = answer.status === 202 && typeof answer.body?.jobId === "string";
    if (!jobShaped) {
      const why = `POST /v1/admin/clients answered ${answer.status}${answer.body?.jobId ? "" : " with no jobId"}, so the job-shaped route (item A) is not on this tip`;
      for (const label of [
        "the 202 arrives in under 2 s carrying the temporary password",
        "the five steps appear in the ledger in order with the right observables",
        "the ready step is accepted only on how=gateway",
        "the Titan step calls listAgents and getOnboardingState and NOTHING else",
        "the sweep is asked once per slug and a 503 is retried",
        "the welcome is captured, its link works once and is then dropped",
      ]) skip(label, why);
      info("run this arm again on the merged tip; --remove-only is item C's own gate and needs none of it");
      return;
    }

    await checking("the 202 arrives in under 2 s carrying the temporary password", async () => {
      const took = Date.now() - started;
      assert.equal(answer.status, 202);
      assert.equal(typeof answer.body.temporaryPassword, "string");
      assert.ok(answer.body.temporaryPassword.length >= 12, "the temporary password is too short to be one");
      assert.ok(took < 2_000, `it took ${took} ms`);
      return `${took} ms on this Mac, password in the first answer and nowhere else`;
    });

    const slug = answer.body?.tenant?.slug ?? answer.body?.slug ?? "";
    let state = null;
    const deadline = Date.now() + 120_000;
    for (;;) {
      state = (await ask("GET", `/v1/admin/clients/${encodeURIComponent(slug)}/onboarding`)).body;
      if (state?.done === true || state?.status === "failed" || state?.status === "stopped") break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await checking("the five steps appear in order with the right observables", async () => {
      const names = (state?.steps ?? []).map((row) => row.name);
      assert.deepEqual(names, ["workspace", "box", "titan", "addresses", "welcome"], names.join(" > "));
      return names.join(" > ");
    });
    await checking("the ready step is accepted only on how=gateway", async () => {
      const boxStep = (state?.steps ?? []).find((row) => row.name === "box");
      assert.equal(boxStep?.status, "ok", `the box step is ${boxStep?.status}`);
      const ledger = cp.store.listSteps(slug).find((row) => row.step === "ready");
      assert.match(String(ledger?.detail ?? ""), /"how":"gateway"/, "a coolify how was accepted as ready");
      return "a created container is not a booted host";
    });
    await checking("the Titan step calls listAgents and getOnboardingState and NOTHING else", async () => {
      assert.ok(box.calls.includes("listAgents"), "listAgents was never called");
      assert.ok(box.calls.includes("getOnboardingState"), "getOnboardingState was never called");
      const forbidden = box.calls.filter((call) => /sendPrompt|createAgent|duplicateAgent|startOnboarding/.test(call));
      assert.deepEqual(forbidden, [], `the sequencer prompted a fresh box: ${forbidden.join(", ")}`);
      return `${box.calls.length} gateway calls, none of them a prompt`;
    });
    await checking("the sweep is asked once per slug and a 503 is retried", async () => {
      const sweeps = relay.callsTo("/mail/sweep");
      assert.ok(sweeps.length >= 2, "the 503 was not retried");
      for (const sweep of sweeps) {
        assert.equal(String(sweep.body?.slug ?? ""), slug, "a sweep went fleet-wide and reached every other customer's box");
      }
      return `${sweeps.length} sweeps, every one of them naming ${slug} only`;
    });
    await checking("the welcome is captured, its link works once, and it is then dropped", async () => {
      const sent = relay.mail();
      assert.equal(sent.length, 1, `${sent.length} mails were sent`);
      assert.equal(sent[0].to, "gate@onboard.test", "the welcome went to the owner instead of the override");
      assert.ok(String(sent[0].text ?? "").length > 0, "there is no plain-text alternative");
      const link = /https?:\/\/[^\s"'<>]*\/login\?sso=[A-Za-z0-9._-]+/.exec(String(sent[0].html ?? ""));
      assert.ok(link, "the mail carries no sign-in link");
      // Exercised and dropped. It is a stateless bearer with no revocation, so it is never written
      // to a file, a log line or this gate's output.
      const landed = await fetch(link[0].replace(/^https?:\/\/[^/]+/, relay.url), { headers: { "user-agent": UA } })
        .then((response) => response.status).catch(() => 0);
      assert.notEqual(landed, 0, "the sign-in link could not be exercised");
      return `one recipient, a plain-text alternative, and a link the relay answered ${landed} to`;
    });
    await checking("the removal leaves nothing and frees the name", async () => {
      const removed = await ask("DELETE", `/v1/admin/clients/${encodeURIComponent(slug)}`, { confirm: slug, deleteData: true });
      assert.equal(removed.body?.ok, true, removed.body?.message ?? `it answered ${removed.status}`);
      assert.equal(cp.store.getTenant(slug), null);
      assert.equal(cp.store.isSlugRetired(slug), false);
      return removed.body.message.slice(0, 160);
    });
  } finally {
    await cp.dispose();
    await box.close();
    await relay.close();
    await coolify.close();
  }
}

// ---- the run ------------------------------------------------------------------------------------

console.log(`verify-onboard -- ONBOARD-2${REMOVE_ONLY ? ", the removal arm only" : ""}, on this Mac, ${new Date().toISOString()}`);
await removeArm();
if (!REMOVE_ONLY) await sequenceArm();

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${passes} passed, ${failures} failed, ${notMeasured} not measured`);
process.exit(failures > 0 ? 1 : passes === 0 ? 2 : 0);
