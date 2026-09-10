// ONBOARD-2 item 3: removing a customer, and the four ways it must refuse.
//
// Every assertion here is about an EFFECT, in an ORDER, with a PROOF. The removal's whole reason to
// exist is that Coolify's 200 is not a removed container, so the tests that matter most are the
// ones where Coolify says yes and the host says no.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createDecommission, REFUSALS } from "../cp/decommission.mjs";
import { createMailDirectory } from "../cp/mail.mjs";
import {
  boxContainerName, containerProbe, createCoolifyClient, createRelayAsk, loadConfig, tenantDirectory, waitForBox,
} from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";
import { makeTempRoot, startFakeCoolify, startFakeRelay } from "./cp-support.mjs";

// ---- the world ----------------------------------------------------------------------------------

/**
 * A control plane's store, config, fake Coolify and fake relay, wired the way the R750 wires them:
 * the relay reads the HOST for container names and Coolify reads its own records, and the two are
 * deliberately not the same source of truth.
 */
async function withWorld(run, options = {}) {
  const root = await makeTempRoot("cp-remove-");
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
    ...(options.env ?? {}),
  });
  const store = openStore({ dataDir: config.dataDir });
  const client = createCoolifyClient({ config });
  const askRelayPost = createRelayAsk({ config, timeoutMs: 4_000 });
  try {
    await run({ root, config, store, client, coolify, relay, askRelayPost });
  } finally {
    store.close();
    await relay.close();
    await coolify.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * One customer, built the way provisioning builds one: a Coolify service that has been started, a
 * tenant row pointing at it, an account, a bot address and a data directory. Nothing here calls
 * provisionTenant, because these tests are about taking a customer away and a slow build in the
 * middle of each of them buys nothing.
 */
async function makeCustomer({ config, store, client, coolify, relay }, options = {}) {
  const slug = options.slug ?? "acme-roofing";
  const created = await client.createService({ name: `titanbot-${slug}`, docker_compose_raw: "services:\n  titanbot-box:\n    image: x\n" });
  await client.startService(created.uuid);
  const container = boxContainerName(created.uuid);
  store.createTenant({ slug, name: options.name ?? "Acme Roofing", host: "console.titanium.bot", status: "running", ownerEmail: options.email ?? "jane@acme.test" });
  store.updateTenant(slug, { coolifyServiceUuid: created.uuid, boxContainer: container, boxReady: true });
  const account = store.createAccount({ email: options.email ?? "jane@acme.test", password: "a-long-enough-password", name: "Jane", tenant: slug });
  const address = store.mintMailCode({ tenant: slug, agentId: "titan-1", agentName: "Titan", domain: "myagents.email" });
  const dataPath = tenantDirectory(slug, config);
  mkdirSync(path.join(dataPath, "volumes", "data"), { recursive: true });
  writeFileSync(path.join(dataPath, "volumes", "data", "settings.json"), "{}");
  relay.names.set(slug, container);
  relay.data.set(slug, { path: dataPath, bytes: 6_200_000 });
  void coolify;
  return { slug, uuid: created.uuid, container, account, address, dataPath };
}

/** The decommission under test, with the calls it makes to Coolify and the proxy recorded in order. */
function decommissionFor(world, options = {}) {
  const order = [];
  const proxy = options.proxy ?? {
    configured: true,
    async deleteKeyByAlias(slug) { order.push(`proxy:${slug}`); return { ok: true, alias: `titanbot-${slug}` }; },
  };
  const client = {
    stopService: async (uuid) => { order.push("stop"); return world.client.stopService(uuid); },
    deleteService: async (uuid) => { order.push("delete"); return world.client.deleteService(uuid); },
    getService: async (uuid) => { order.push("get"); return world.client.getService(uuid); },
  };
  const decommission = createDecommission({
    store: world.store,
    config: world.config,
    client,
    proxy,
    askRelayPost: world.askRelayPost,
    sleep: async () => {},
    ...(options.deps ?? {}),
  });
  return { decommission, order };
}

// ---- the four refusals, each of which must have NO effect ---------------------------------------

test("an unknown workspace is refused and nothing is called on Coolify", async () => {
  await withWorld(async (world) => {
    const { decommission, order } = decommissionFor(world);
    const answer = await decommission.remove({ slug: "nobody-here", confirm: "nobody-here" });
    assert.equal(answer.ok, false);
    assert.equal(answer.status, "not_found");
    assert.equal(answer.message, REFUSALS.not_found("nobody-here"));
    assert.deepEqual(order, []);
    assert.deepEqual(world.coolify.routes().filter((route) => route.startsWith("DELETE")), []);
  });
});

test("an adopted workspace is refused 409 and NOTHING is called on Coolify", async () => {
  // This is the guard that makes tenant `titanium` -- whose Coolify service IS the live console --
  // impossible to remove from here. It reads the ledger as well as the status column, because a
  // stop writes "stopped" over "adopted" and a guard that read only the column could be walked
  // around by stopping first.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.store.recordStep({ slug: built.slug, step: "adopt", status: "ok", detail: "{}" });
    world.store.updateTenant(built.slug, { status: "stopped" });
    const before = world.coolify.calls.length;
    const { decommission, order } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
    assert.equal(answer.ok, false);
    assert.equal(answer.status, "adopted");
    assert.equal(answer.message, REFUSALS.adopted());
    assert.deepEqual(order, [], "an adopted workspace reached neither Coolify nor the proxy");
    assert.equal(world.coolify.calls.length, before, "not one call went to Coolify");
    assert.notEqual(world.store.getTenant(built.slug), null, "the tenant row is still there");
    assert.equal(world.store.getAccountByEmail("jane@acme.test").disabled, false, "nobody's sign-in was closed");
    assert.equal(existsSync(built.dataPath), true);
  });
});

test("one of the product's own names is refused before anything happens", async () => {
  await withWorld(async (world) => {
    // `titanium` is reserved AND adopted in production. Reserved alone has to be enough, so this
    // row is built without the adopt step to prove the second guard stands on its own.
    const built = await makeCustomer(world, { slug: "titanium", name: "Titanium Computing" });
    const { decommission, order } = decommissionFor(world);
    const answer = await decommission.remove({ slug: "titanium", confirm: "titanium" });
    assert.equal(answer.ok, false);
    assert.equal(answer.status, "operator_slug");
    assert.equal(answer.message, REFUSALS.operator_slug("titanium"));
    assert.deepEqual(order, []);
    assert.notEqual(world.store.getTenant("titanium"), null);
    void built;
  });
});

test("a confirm that is not the workspace name is refused and nothing moves", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission, order } = decommissionFor(world);
    for (const confirm of ["", "acme", "ACME-ROOFING", "acme-roofing "]) {
      const answer = await decommission.remove({ slug: built.slug, confirm });
      assert.equal(answer.ok, false, `"${confirm}" should not confirm`);
      assert.equal(answer.status, "confirm_required");
      assert.equal(answer.message, REFUSALS.confirm_required(built.slug));
    }
    assert.deepEqual(order, []);
    assert.notEqual(world.store.getTenant(built.slug), null);
    assert.equal(world.store.listMailAddresses(built.slug)[0].state, "active");
  });
});

// ---- the order of effects -----------------------------------------------------------------------

test("the effects happen in the documented order, and the addresses go before the container", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission, order } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, actor: "operator@titanium.bot" });
    assert.equal(answer.ok, true, answer.message);
    assert.deepEqual(
      answer.effects.map((effect) => effect.step),
      ["disable-signins", "addresses", "proxy-key", "stop", "service", "container-gone", "data", "accounts", "audit-ready"],
    );
    // And the same order over the wire: the key is revoked BEFORE the service is deleted. A key
    // revoked after a FAILED delete leaves a box running with a credential the operator believes
    // they took away.
    assert.equal(order.indexOf("proxy:acme-roofing") < order.indexOf("delete"), true, `proxy must precede delete, got ${order.join(" ")}`);
    assert.equal(order.indexOf("stop") < order.indexOf("delete"), true, `stop must precede delete, got ${order.join(" ")}`);
    // The addresses were retired before the container went, because after the box is gone nothing
    // would ever retire them: the sweep only retires codes missing from a roster it could READ.
    const addresses = answer.effects.findIndex((effect) => effect.step === "addresses");
    const gone = answer.effects.findIndex((effect) => effect.step === "container-gone");
    assert.equal(addresses < gone, true);
    assert.equal(world.store.getMailAddressByCode(built.address.code).state, "retired");
  });
});

test("the delete puts docker_cleanup=false, delete_volumes=false and delete_connected_networks=true on the wire", async () => {
  // docker_cleanup=true dispatches Coolify's CleanupDocker across the WHOLE server: container prune,
  // image prune, a broader image prune and builder prune -af. The R750 also runs ampcortex, anvil,
  // Coolify's own stack, every other customer's box and Jason's images. Removing one customer must
  // never prune Jason's server.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug });
    assert.equal(answer.ok, true, answer.message);
    const deletes = world.coolify.callsTo("DELETE /services/{uuid}");
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].query, {
      delete_configurations: "true",
      delete_volumes: "false",
      docker_cleanup: "false",
      delete_connected_networks: "true",
    });
  });
});

// ---- the proof that matters ---------------------------------------------------------------------

test("Coolify forgetting the service while the container runs is reported as NOT ok, and the tenant row survives", async () => {
  // Coolify's DeleteResourceJob wraps its remote block in a catch that logs "Remote cleanup failed,
  // continuing with local deletion" and deletes the local record anyway. So the worst failure in the
  // product answers 200 and looks like success. A removal that reported success here would leave a
  // container running with the customer's gateway token and no row saying it exists.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.coolify.neverRemoves = true;
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({
      slug: built.slug, confirm: built.slug, deleteData: true, containerDeadlineMs: 60, pollMs: 10,
    });

    assert.equal(answer.ok, false, "a container that is still there is never a success");
    assert.equal(answer.status, "container_still_there");
    assert.equal(answer.containerGone, false);
    assert.equal(answer.provedBy, "");
    assert.match(answer.message, /the container is still running/);
    assert.match(answer.message, new RegExp(`docker rm -f ${built.container}`));

    // It stopped BEFORE the data step and before the accounts step.
    const steps = answer.effects.map((effect) => effect.step);
    assert.equal(steps.includes("data"), false, "the data step must not run when the container is still there");
    assert.equal(steps.includes("accounts"), false);
    assert.equal(answer.dataDeleted, false);
    assert.equal(existsSync(built.dataPath), true, "the customer's data is untouched");

    // And the row is still a workspace, so an operator can see it and finish it.
    assert.notEqual(world.store.getTenant(built.slug), null, "the tenant row survives a removal that could not finish");
    assert.notEqual(world.store.getAccountByEmail("jane@acme.test"), null);
    // The sign-ins stay closed, which is right: the box is still up and nobody should reach it.
    assert.equal(world.store.getAccountByEmail("jane@acme.test").disabled, true);
    assert.equal(world.coolify.containerPresent(built.container), true);
  });
});

test("a delete whose remote half lands late is waited for, and the answer names which proof it used", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.coolify.deleteDelayMs = 120;
    const { decommission } = decommissionFor(world, { deps: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } });
    const answer = await decommission.remove({
      slug: built.slug, confirm: built.slug, containerDeadlineMs: 5_000, pollMs: 25,
    });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.containerGone, true);
    assert.equal(answer.provedBy, "docker", "the relay's docker view is the proof, not Coolify's 404");
    assert.equal(world.coolify.containerPresent(built.container), false);
    assert.match(answer.message, /the relay says the name is absent/);
  });
});

test("with no relay to ask, Coolify answering 404 is taken as the second proof and is named as such", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world, {
      deps: {
        askRelayPost: async () => ({ ok: false, status: 0, body: null, why: "this control plane has no relay configured" }),
      },
    });
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, containerDeadlineMs: 200, pollMs: 20 });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.provedBy, "coolify-404");
    assert.match(answer.message, /Coolify no longer has the service; the relay could not be asked/);
  });
});

test("a Coolify 404 never closes the step when the relay says the container is still there", async () => {
  // The dangerous combination, and the reason the second proof is conditional: Coolify has forgotten
  // the service (404) AND the container is up. Taking the 404 here is precisely the bug.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.coolify.neverRemoves = true;
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, containerDeadlineMs: 60, pollMs: 10 });
    assert.equal(answer.ok, false);
    assert.equal(answer.provedBy, "");
  });
});

// ---- the data switch ----------------------------------------------------------------------------

test("with the data switch off the directory is untouched and the sentence says nothing deletes it on a timer", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: false });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.dataDeleted, false);
    assert.equal(existsSync(built.dataPath), true);
    const kept = answer.effects.find((effect) => effect.step === "data");
    assert.equal(kept.status, "kept");
    assert.equal(kept.detail, `Their data is kept at ${built.dataPath}. Nothing deletes it on a timer.`);
    assert.match(answer.message, /Nothing deletes it on a timer\./);
    // And it must NOT claim thirty days. There is no reaper in this product and nothing counts days.
    assert.equal(/thirty days|30 days/i.test(answer.message), false);
    assert.equal(world.relay.callsTo("/tenant/purge").some((call) => call.body?.probeOnly !== true), false,
      "with the switch off the relay is never asked to delete anything");
  });
});

test("with the data switch on the relay is asked and the tree is gone", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.dataDeleted, true);
    assert.equal(answer.bytesFreed, 6_200_000);
    assert.equal(world.relay.data.has(built.slug), false, "the relay removed its record of the tree");
    const purges = world.relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
    assert.equal(purges.length, 1, "one purge, and one only");
    // THE BODY THE ROUTE TAKES. `confirm` because ui/purge-edge.mjs refuses a body without it, and
    // `container` because by now the relay's registry has forgotten this workspace and the route
    // cannot otherwise name the computer it has to prove absent. Asserted as the exact key set so a
    // field going missing is a failing test rather than a 400 nobody reads.
    assert.deepEqual(Object.keys(purges[0].body).sort(), ["confirm", "container", "slug"]);
    assert.equal(purges[0].body.confirm, built.slug);
    assert.equal(purges[0].body.container, built.container);
    // And still never a PATH: the relay resolves the directory from its own tenant root.
    assert.equal(Object.keys(purges[0].body).some((key) => /path|dir/i.test(key)), false,
      "the control plane never sends the relay a PATH");
    assert.match(answer.message, /Their data is gone/);
  });
});

test("a registry that still reaches the workspace is asked again rather than read as a failure", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    // THE REAL RELAY'S REGISTRY REFRESHES ON ITS OWN CLOCK. For up to one refresh after the container
    // is gone it still holds an entry for the workspace, and ui/purge-edge.mjs answers 409
    // still_reachable on that rather than deleting a live customer's data. It clears itself, so the
    // caller polls; a caller that read the first 409 as "the relay said no" would delete nothing and
    // tell the operator their data could not be removed.
    world.relay.state.registryLag = 2;
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true, pollMs: 5 });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.dataDeleted, true, answer.message);
    assert.equal(answer.bytesFreed, 6_200_000);
    assert.equal(existsSync(built.dataPath), false);
    const purges = world.relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
    // More than one removal request, which is the whole point: the first was refused and asked again.
    // Not an exact count, because the container-gone probe reads the registry too and consumes a turn
    // of the lag, and pinning that number would make this test about the probe instead.
    assert.ok(purges.length >= 2, `one refusal and one success at least, saw ${purges.length}`);
    for (const call of purges) {
      assert.equal(call.body.confirm, built.slug, "every try carries the confirm");
      assert.equal(call.body.container, built.container, "every try names the container");
    }
  });
});

test("a registry that never lets go records carried-on and says so, with the data still there", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.relay.state.registryLag = 1_000;
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({
      slug: built.slug, confirm: built.slug, deleteData: true, pollMs: 5, dataDeadlineMs: 40,
    });
    assert.equal(answer.ok, true, "the container is proved gone, so the customer is off the air either way");
    assert.equal(answer.dataDeleted, false);
    assert.equal(existsSync(built.dataPath), true, "nothing was deleted");
    const carried = answer.effects.find((effect) => effect.step === "data");
    assert.equal(carried.status, "carried-on");
    assert.match(carried.detail, /can still reach that workspace/);
    assert.match(answer.message, /Their data could NOT be deleted/);
  });
});

test("a purge the relay refuses does not strand the removal, and the answer says the data is still there", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.relay.state.purgeRefusal = "that workspace is still in the registry";
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
    assert.equal(answer.ok, true, "the container is proved gone, so the customer is off the air either way");
    assert.equal(answer.dataDeleted, false);
    assert.match(answer.message, /Their data could NOT be deleted/);
    assert.match(answer.message, /Nothing deletes it on a timer\./);
    assert.equal(world.store.getTenant(built.slug), null, "the workspace is still removed");
  });
});

test("a purge that dies on the wire is asked again, and the bytes it reports are the bytes in the message", async () => {
  // ONBOARD-2, FAULT 4, measured on the R750 2026-09-10. The removal ran 33.959 s, the container was
  // proved gone, and the data step reported "carried-on, 0 bytes freed" with NO purge line in the
  // relay's stdout for the whole window: the request never arrived. createRelayAsk answers status 0
  // for a transport failure, the step was single-shot, and the operator was told the data could not be
  // deleted. The route is idempotent, so asking again is safe and is the only honest answer.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.relay.state.purgeTransportFailures = 1;
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true, pollMs: 5 });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.dataDeleted, true, answer.message);
    assert.equal(answer.bytesFreed, 6_200_000);
    assert.equal(existsSync(built.dataPath), false, "the tree is gone");
    // THE NUMBER IN THE SENTENCE IS THE NUMBER THE ROUTE REPORTED, and not a number this file carries.
    assert.match(answer.message, /6200000 bytes came back/);
    assert.equal(answer.dataWhy, "", "nothing refused in the end, so there is nothing to explain");
    const purges = world.relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
    assert.ok(purges.length >= 2, `one dropped and one answered at least, saw ${purges.length}`);
    const data = answer.effects.find((effect) => effect.step === "data");
    assert.equal(JSON.parse(data.detail).tries >= 2, true, data.detail);
  });
});

test("a registry that holds on for eighty seconds is still inside the budget", async () => {
  // THE OTHER HALF OF THE SAME ARITHMETIC. The relay's registry refreshes on a 60 second timer, so the
  // poll has to outlast one full cycle. It was 30 s, with a comment claiming it was waiting on that
  // refresh, and it lost the race every time.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    // Nine refreshes: the route spends one per call, so this is eight polls at ten seconds before the
    // ninth call goes through, which is the case a 30 second budget could never have survived.
    world.relay.state.registryLag = 9;
    let clock = 1_700_000_000_000;
    const started = clock;
    const { decommission } = decommissionFor(world, {
      deps: { now: () => clock, sleep: async (ms) => { clock += Number(ms) || 0; } },
    });
    const answer = await decommission.remove({
      slug: built.slug, confirm: built.slug, deleteData: true, pollMs: 10_000,
    });
    assert.equal(answer.dataDeleted, true, answer.message);
    assert.equal(existsSync(built.dataPath), false);
    assert.ok(clock - started >= 80_000, `the poll only lasted ${clock - started} ms`);
    assert.ok(world.relay.state.refreshes >= 9, `the route refreshed ${world.relay.state.refreshes} time(s)`);
  });
});

test("a purge that is refused leaves its reason on the one ledger row that outlives the tenant", async () => {
  // FAULT 5(a). The refusal existed in exactly two places and both threw it away: the remove:data
  // ledger row, which store.deleteTenant wipes one step later by design, and the effects array, which
  // the gate printed as step=status with the detail dropped. So the cause had to be named by
  // arithmetic. The audit-ready row is the one that survives, so that is where it goes.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.relay.state.purgeRefusal = "that workspace is still in the registry";
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true, actor: "operator@titanium.bot" });
    assert.equal(answer.ok, true);
    assert.equal(answer.dataDeleted, false);
    assert.match(answer.dataWhy, /still in the registry/, answer.dataWhy);
    assert.match(answer.dataWhy, /asked 1 time/, answer.dataWhy);

    const row = world.store.listSteps(built.slug).find((one) => one.step === "remove:audit-ready");
    assert.ok(row != null, "the audit-ready row is the breadcrumb that outlives the tenant");
    const detail = JSON.parse(row.detail);
    assert.match(String(detail.dataWhy), /still in the registry/);
    assert.equal(detail.dataDeleted, false);
    assert.equal(detail.bytesFreed, 0);
    // AND NOTHING ELSE RIDES ALONG. No credential, and no path outside the workspace's own tree.
    assert.equal(row.detail.includes(world.relay.token), false, "a relay token is in an audit row");
    assert.equal(/\/(etc|root|home|Users)\//.test(row.detail), false, row.detail);
  });
});

test("an address minted while the removal is running is retired before the removal finishes", async () => {
  // FAULT 3(b), measured on the R750 2026-09-10. The removal retires at step 2 and this control plane
  // keeps serving the tenant row to the relay until step 8, so the five minute sweep read a roster off
  // a box that was not dead yet and minted agent218973@myagents.email 28.7 s into a teardown that had
  // already reported "0 bot addresses retired". It was active, for a customer who no longer existed,
  // and nothing would ever have retired it.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world, {
      // Step 3, which lands between the retire at step 2 and the delete at step 8. This is the sweep
      // arriving in the middle of the removal, which is the only way that row ever gets written.
      proxy: {
        configured: true,
        async deleteKeyByAlias(slug) {
          world.store.mintMailCode({ tenant: slug, agentId: "titan-2", agentName: "Titan", domain: "myagents.email" });
          return { ok: true, alias: `titanbot-${slug}` };
        },
      },
    });
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true });
    assert.equal(answer.ok, true, answer.message);

    const left = world.store.listMailAddresses(built.slug).filter((row) => row.state === "active");
    assert.deepEqual(left, [], "an address outlived the customer it belonged to");
    // BOTH RETIRES ARE COUNTED, and the sentence says where the second one came from.
    assert.match(answer.message, /2 bot addresses retired \(1 of them minted while the removal was running\)/);
    assert.equal(answer.addressesRetired.length, 2);
    assert.equal(answer.effects.some((effect) => effect.step === "addresses-late"), true);
    const row = world.store.listSteps(built.slug).find((one) => one.step === "remove:audit-ready");
    assert.equal(JSON.parse(row.detail).addresses, 2);
  });
});

// ---- what is left afterwards --------------------------------------------------------------------

test("afterwards there is no tenant row, no account, the slug is not retired, and the name is offered again", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const second = world.store.createAccount({ email: "sam@acme.test", password: "a-long-enough-password", name: "Sam", tenant: built.slug });
    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug, deleteData: true, actor: "operator@titanium.bot" });
    assert.equal(answer.ok, true, answer.message);

    assert.equal(world.store.getTenant(built.slug), null, "no tenant row");
    assert.equal(world.store.getAccountByEmail("jane@acme.test"), null, "no account");
    assert.equal(world.store.getAccountByEmail("sam@acme.test"), null, "no second account");
    assert.deepEqual(answer.accountsRemoved.sort(), ["jane@acme.test", "sam@acme.test"]);
    // THE ORDER IS LOAD-BEARING. deleteTenant inserts a retired_slugs row while an account still
    // points at the slug; deleteAccount clears it only once the tenant row is gone and no account is
    // left. Tenant first, then the accounts, then releaseSlug as a belt, and the name is genuinely
    // free -- which is what lets the same company be built again for a test.
    assert.equal(world.store.isSlugRetired(built.slug), false, "the name is not held back");
    assert.equal(answer.slugFree, true);
    // And the store really will take it again.
    const again = world.store.createTenant({ slug: built.slug, name: "Acme Roofing", host: "console.titanium.bot", status: "provisioning" });
    assert.equal(again.slug, built.slug);
    void second;
  });
});

test("every active address for the workspace is retired, and a code is never handed back", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const scribe = world.store.mintMailCode({ tenant: built.slug, agentId: "scribe-1", agentName: "Scribe", domain: "myagents.email" });
    // A neighbour's address, which must survive untouched.
    world.store.createTenant({ slug: "north-bay", name: "North Bay", host: "console.titanium.bot", status: "running" });
    const neighbour = world.store.mintMailCode({ tenant: "north-bay", agentId: "titan-1", agentName: "Titan", domain: "myagents.email" });

    const { decommission } = decommissionFor(world);
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug });
    assert.equal(answer.ok, true, answer.message);
    assert.deepEqual(answer.addressesRetired.sort(), [built.address.address, scribe.address].sort());
    for (const code of [built.address.code, scribe.code]) {
      assert.equal(world.store.getMailAddressByCode(code).state, "retired");
    }
    assert.equal(world.store.getMailAddressByCode(neighbour.code).state, "active", "the neighbour keeps their address");
  });
});

test("the sign-ins are closed first, before anything reaches Coolify", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const seen = [];
    const { decommission } = decommissionFor(world, {
      deps: {
        client: {
          stopService: async (uuid) => { seen.push(`stop:${world.store.getAccountByEmail("jane@acme.test")?.disabled}`); return world.client.stopService(uuid); },
          deleteService: async (uuid) => world.client.deleteService(uuid),
          getService: async (uuid) => world.client.getService(uuid),
        },
      },
    });
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug });
    assert.equal(answer.ok, true, answer.message);
    assert.deepEqual(seen, ["stop:true"], "the account was already disabled when the stop went out");
  });
});

test("a proxy that will not revoke does not stop the removal, and the answer names the command that finishes it", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const { decommission } = decommissionFor(world, {
      proxy: { configured: true, deleteKeyByAlias: async () => ({ ok: false, why: "the proxy did not answer" }) },
    });
    const answer = await decommission.remove({ slug: built.slug, confirm: built.slug });
    assert.equal(answer.ok, true, answer.message);
    assert.match(answer.message, /could NOT be revoked/);
    assert.match(answer.message, new RegExp(`proxy revoke ${built.slug}`));
    assert.equal(answer.effects.find((effect) => effect.step === "proxy-key").status, "carried-on");
  });
});

// ---- plan, the sentence the confirm panel reads --------------------------------------------------

test("the plan says what is about to happen before anything happens", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    const before = world.coolify.calls.length;
    const plan = world.store == null ? null : createDecommission({
      store: world.store, config: world.config, client: world.client, askRelayPost: world.askRelayPost,
    }).plan(built.slug);
    assert.equal(plan.ok, true);
    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.accounts, ["jane@acme.test"]);
    assert.equal(plan.addresses, 1);
    assert.equal(plan.dataPath, built.dataPath);
    assert.equal(plan.container, built.container);
    assert.equal(world.coolify.calls.length, before, "a plan touches nothing");
  });
});

test("a caller with a mail directory gets the same address count the operator's Mail page shows", async () => {
  // Read through the directory rather than the store when there is one, so the number on the confirm
  // panel cannot disagree with the number the operator was just looking at.
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.store.mintMailCode({ tenant: built.slug, agentId: "scribe-1", agentName: "Scribe", domain: "myagents.email" });
    const mailDirectory = createMailDirectory({ store: world.store, domain: "myagents.email" });
    const decommission = createDecommission({
      store: world.store, config: world.config, client: world.client, askRelayPost: world.askRelayPost, mailDirectory,
    });
    assert.equal(decommission.plan(built.slug).addresses, 2);
    // And a retired one does not count, on either path.
    world.store.retireMailAddress(built.address.code);
    assert.equal(decommission.plan(built.slug).addresses, 1);
  });
});

test("the plan refuses an adopted workspace and an unknown one in the same words the removal uses", async () => {
  await withWorld(async (world) => {
    const built = await makeCustomer(world);
    world.store.recordStep({ slug: built.slug, step: "adopt", status: "ok", detail: "{}" });
    const decommission = createDecommission({ store: world.store, config: world.config, client: world.client, askRelayPost: world.askRelayPost });
    assert.equal(decommission.plan(built.slug).why, REFUSALS.adopted());
    assert.equal(decommission.plan("nobody-here").why, REFUSALS.not_found("nobody-here"));
  });
});

// ---- the provisioning fixes this item ships alongside --------------------------------------------

test("the readiness probe asks the path the host actually serves, and records the status it got", async () => {
  // It used to ask /api/health, which the bundle does not serve: measured 404. The relay's own
  // per-tenant health proxy asks ${gateway}/health (ui/server.mjs:4444), which is the same question
  // put the right way.
  const asked = [];
  const verdict = await waitForBox({
    client: { getService: async () => ({ status: "exited", applications: [] }) },
    uuid: "svc-1",
    gateway: "http://titanbot-box-svc-1:1340",
    token: "a-token",
    probeImpl: async (url, init) => { asked.push(`${url} ${init.headers.authorization}`); return { status: 200 }; },
    timeoutMs: 1_000,
    intervalMs: 10,
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.how, "gateway");
  assert.equal(verdict.status, 200);
  assert.deepEqual(asked, ["http://titanbot-box-svc-1:1340/health Bearer a-token"]);
  assert.equal(asked[0].includes("/api/health"), false, "the host does not serve /api/health");
});

test("the container probe answers null rather than false when the relay could not be asked", async () => {
  // Null is never a proof of absence. The one failure this whole path exists for looks like silence
  // from every angle except the docker socket, so "could not tell" has to be its own answer.
  const quiet = await containerProbe({ askRelayPost: async () => ({ ok: false, status: 0, body: null, why: "no relay" }), slug: "acme" });
  assert.equal(quiet.present, null);
  const vague = await containerProbe({ askRelayPost: async () => ({ ok: true, status: 200, body: { ok: true } }), slug: "acme" });
  assert.equal(vague.present, null);
  const there = await containerProbe({ askRelayPost: async () => ({ ok: true, status: 200, body: { containerPresent: true } }), slug: "acme" });
  assert.equal(there.present, true);
  const gone = await containerProbe({ askRelayPost: async () => ({ ok: true, status: 200, body: { container: { present: false } } }), slug: "acme" });
  assert.equal(gone.present, false);
});

test("a control plane with no relay configured refuses in words rather than throwing", async () => {
  const ask = createRelayAsk({ config: { relayUrl: "", relayToken: "" } });
  const answer = await ask("/tenant/purge", { slug: "acme" });
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 0);
  assert.match(answer.why, /CP_RELAY_URL and CP_RELAY_TOKEN/);
});

// ---- the CLI's shape ----------------------------------------------------------------------------

test("the CLI registers tenant remove and mail welcome-reply-to, and signup add goes through the one sequence", async () => {
  const cli = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../cp/cli.mjs", import.meta.url), "utf8"));
  assert.ok(cli.includes('"tenant remove": tenantRemove'), "tenant remove is not in the dispatch table");
  assert.ok(cli.includes('"mail welcome-reply-to": mailWelcomeReplyTo'), "mail welcome-reply-to is not in the dispatch table");
  assert.ok(cli.includes("node cp/cli.mjs tenant remove <slug> [--delete-data] [--yes]"), "tenant remove is not in the help text");
  assert.ok(cli.includes("node cp/cli.mjs mail welcome-reply-to [<address>]"), "mail welcome-reply-to is not in the help text");
  // ADMIN-2b narrowed: the CLI and the console run ONE sequence, so both get the welcome. The
  // self-serve door at POST /v1/signups stays where it is and sends no welcome.
  assert.ok(/signupAdd[\s\S]{0,1600}\/v1\/admin\/clients/.test(cli), "signup add must post to /v1/admin/clients");
  assert.equal(/signupAdd[\s\S]{0,1600}"\/v1\/signups"/.test(cli), false, "signup add must not use the self-serve door any more");
});

test("no mail DIRECTORY verb opens the store, and the welcome setting verb says where it runs", async () => {
  // The existing rule, restated because this item adds a verb to the mail group: on the R750 the
  // store is inside the control plane container and the operator types this on a Mac, so a
  // directory verb that opened sqlite reads an empty file of its own. mail welcome-reply-to is NOT
  // a directory verb -- it writes an operator setting -- so it sits above the section with the
  // proxy verbs that have the same constraint, and its help line says so out loud.
  const cli = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../cp/cli.mjs", import.meta.url), "utf8"));
  const section = cli.slice(cli.indexOf("async function mailList"), cli.indexOf("const [group, action, ...rest]"));
  assert.equal(/openLedger\s*\(/.test(section), false);
  assert.equal(section.includes("function mailWelcomeReplyTo"), false, "the welcome setting verb is not a directory verb and must not sit in that section");
  assert.ok(cli.includes("mail welcome-reply-to runs in the control plane container"), "the help text must say where this verb runs");
});
