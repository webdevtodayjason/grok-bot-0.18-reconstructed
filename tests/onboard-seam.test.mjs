// ONBOARD-2, THE SEAM. The sequencer driving the REAL welcome sender and the REAL removal library,
// with no double standing in for either.
//
// WHY THIS FILE EXISTS, because it is the test that would have caught the thing that was broken.
// The wave was built as three items merged topologically, and each item's own suite passes standalone
// by injecting doubles for the other two: tests/cp-onboard.test.mjs drives a stubWelcome and a
// stubDecommission, while tests/cp-welcome.test.mjs and tests/cp-remove.test.mjs call their
// libraries directly. That is the right way to build it in parallel, and it leaves exactly one thing
// untested -- the join. On the first merged tip the join was broken in BOTH directions with all
// three suites green:
//
//   cp/onboard.mjs looked for a flat `sendWelcome(asked)`, while cp/welcome.mjs ships a
//   `createWelcome(...)` factory whose send() takes the owner's address as `email` and hands the
//   fresh link back as `signInUrl`. Every customer's welcome step would have gone amber.
//
//   cp/admin.mjs looked for `removeClient`/`plan`, while cp/decommission.mjs ships a
//   `createDecommission(...)` factory returning `remove`/`plan`. Remove would have answered "this
//   control plane has no removal in it, so nothing was touched" on every press.
//
// Those are the two things Jason asked for. Without this file the R750 run is where we would have
// found out, on a half-built tenant with a real mail key behind it.
//
// What is real here and what is not: everything between the operator's press and the two process
// edges is the product. The relay is a fake because the real one is a different process holding a
// mail key and a docker socket. The box is a stub because reading a real one is what the R750 leg is
// for. Nothing between them is stubbed.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import assertModule from "node:assert/strict";
import test from "node:test";

import { verifySessionToken, tenantSessionSecret } from "../cp/session.mjs";
import { WELCOME_SUBJECT } from "../cp/welcome.mjs";
import { boxContainerName, createCoolifyClient, loadConfig } from "../cp/provision.mjs";
import { startFakeCoolify } from "./cp-support.mjs";
import { makePurgeDouble } from "./purge-double.mjs";
import { probeThrough, startAdminOnly, startStubBox } from "./helpers/onboard-fakes.mjs";

void assertModule;

const TITAN = { id: "agent-titan", name: "Titan", isGroup: false };
const freshBox = { listAgents: [TITAN], getOnboardingState: { done: false, maxAgents: 40 } };

/**
 * A relay that behaves the way the R750's does on the four doors this sequence uses.
 *
 * The sweep is the one worth reading. The real relay does not mint anything itself: it reads the
 * box's roster and POSTs it to the control plane's own /v1/relay/mail/mint, which is what puts the
 * row in the control plane's store and therefore what cp/mail.mjs directory(slug) later reads. That
 * mint route lives in cp/server.mjs, which startAdminOnly does not mount, so this fake reaches the
 * same store directly and says so. The mechanism itself is covered by the mail-directory suites;
 * what matters here is that step 4's green is a DIRECTORY READ in the control plane's own process
 * and not this route's 200, exactly as the design says.
 */
async function startSeamRelay({ store, domain = "myagents.email", containers = new Map(), onHost = null } = {}) {
  const calls = [];
  const mail = [];
  const state = { modelLabel: "", purgeRefusal: null, sweepBusy: 0, data: new Map(), registryLag: 0 };
  const token = `seam-relay-${randomBytes(8).toString("hex")}`;
  // A real directory, because the purge door below is the REAL ui/purge-edge.mjs route and it
  // realpaths its tenant root before it will touch anything under it.
  const tenantRoot = await mkdtemp(path.join(os.tmpdir(), "seam-tenants-"));
  // THE PURGE DOOR IS THE REAL ROUTE. See tests/purge-double.mjs: this file exists to catch two
  // halves of a contract that disagree, and the first version of it hand-wrote the purge answer in
  // the caller's own wrong shape, so the one contract that was genuinely broken -- `{slug}` against a
  // route that refuses anything without `confirm` -- sailed through it.
  const purge = makePurgeDouble({
    relayToken: token,
    tenantRootOf: () => tenantRoot,
    containerFor: (slug) => String(containers.get(String(slug)) ?? ""),
    onHost: (name) => (onHost == null ? false : onHost(name) === true),
    rows: state.data,
    state,
  });

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://seam-relay.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      calls.push({ method: request.method, path: url.pathname, body });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (String(request.headers.authorization ?? "") !== `Bearer ${token}`) return send(401, { error: "unauthorized" });

      const tenantAdmin = /^\/admin\/tenants\/([^/]+)\/(use-included|ceiling|running)$/.exec(url.pathname);
      if (tenantAdmin != null) {
        const slug = decodeURIComponent(tenantAdmin[1]);
        // `read: true` is the relay saying THE BOX ANSWERED, as against this route merely working.
        // The sequencer treats its absence as "nothing could be read back", which is right: a
        // ceiling the box never confirmed is a number in a request and not a setting on a computer.
        if (tenantAdmin[2] === "use-included") { state.modelLabel = String(body?.model ?? "plan-included"); return send(200, { ok: true, slug, model: state.modelLabel, pinned: false }); }
        if (tenantAdmin[2] === "ceiling") return send(200, { ok: true, read: true, slug, maxAgents: Number(body?.maxAgents ?? 40), pinned: false });
        return send(200, { ok: true, read: true, slug, model: state.modelLabel, modelLabel: state.modelLabel, pinned: false });
      }

      if (url.pathname === "/mail/sweep") {
        if (state.sweepBusy > 0) { state.sweepBusy -= 1; return send(503, { ok: false, error: "sweep_running", message: "a sweep is already running" }); }
        const slug = String(body?.slug ?? "");
        if (slug.length === 0) return send(200, { ok: true, swept: [], scope: "fleet" });
        // What the real relay causes to happen, by the route named above.
        const row = store.mintMailCode({ tenant: slug, agentId: TITAN.id, agentName: TITAN.name, domain });
        return send(200, { ok: true, asked: slug, scope: "one", swept: [{ slug, addresses: row == null ? 0 : 1, minted: row == null ? 0 : 1, retired: 0 }] });
      }

      if (url.pathname === "/mail/product") {
        const id = `resend-${randomBytes(8).toString("hex")}`;
        mail.push({ ...body, id });
        // THE RELAY DECIDES THE FROM. A caller that could name one is a caller that will one day
        // send as somebody's personal address because a config value upstream went wrong.
        return send(200, { ok: true, id, from: "Titanium Bot <welcome@titanium.bot>" });
      }

      if (url.pathname === "/tenant/purge") {
        if (state.purgeRefusal != null && body?.probeOnly !== true) {
          return send(409, { ok: false, error: "purge_refused", message: String(state.purgeRefusal) });
        }
        void purge(request, response, Buffer.concat(chunks).toString("utf8"));
        return undefined;
      }
      return send(404, { error: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    token, calls, mail, state, containers, tenantRoot,
    url: `http://127.0.0.1:${server.address().port}`,
    callsTo: (pathname) => calls.filter((call) => call.path === pathname),
    /** A real tree under the real tenant root, with the size the test wants the relay to report. */
    async seedTree(slug, bytes = 6_200_000) {
      const dir = path.join(tenantRoot, String(slug));
      await mkdir(path.join(dir, "volumes", "data"), { recursive: true });
      state.data.set(String(slug), { path: dir, bytes: Number(bytes) });
      return dir;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(tenantRoot, { recursive: true, force: true });
    },
  };
}

test("the real welcome sender, driven by the real sequence, puts one mail on the relay's product door", async () => {
  const box = await startStubBox({ answers: freshBox });
  const coolify = await startFakeCoolify();
  let relay = null;
  let plane = null;
  try {
    // The relay needs the store and the plane needs the relay, so the relay is started over a box
    // that is filled in a line later. This is the only knot in the file.
    const holder = { store: null };
    relay = await startSeamRelay({ store: { mintMailCode: (asked) => holder.store.mintMailCode(asked) } });
    plane = await startAdminOnly({ relay, coolify, probeImpl: probeThrough(box) });
    holder.store = plane.store;

    const added = await plane.request("POST", "/v1/admin/clients", {
      body: {
        name: "Jane Roofer", email: "jane@acmeroofing.com", company: "Acme Roofing",
        planModel: "plan-zai", ceiling: 40,
        sendWelcome: true,
        // The override the R750 measurement uses: ONE recipient, and not the owner's address.
        welcomeTo: "operator@titaniumcomputing.com",
      },
    });
    assert.equal(added.status, 202, added.text);
    const password = String(added.body.temporaryPassword ?? "");
    assert.equal(password.length >= 12, true, "the temporary password is in the first answer or it is nowhere");

    await plane.admin.onboarding.settle("acme-roofing");

    // ---- the five steps, and the fifth is the one that was broken -------------------------------
    const state = await plane.request("GET", "/v1/admin/clients/acme-roofing/onboarding");
    assert.equal(state.status, 200, state.text);
    assert.deepEqual(state.body.steps.map((one) => one.label), [
      "Creating the workspace", "Building the computer", "Waking Titan",
      "Giving the agents their addresses", "Sending the welcome",
    ]);
    const welcome = state.body.steps.at(-1);
    assert.equal(welcome.state, "ok", `the welcome did not send. Every step: ${JSON.stringify(state.body.steps)}`);

    // ---- exactly one mail, on the product door, to the override and to nobody else ---------------
    assert.equal(relay.mail.length, 1, `expected one product mail, got ${relay.mail.length}`);
    const sent = relay.mail[0];
    assert.equal(sent.to, "operator@titaniumcomputing.com");
    assert.equal(sent.slug, "acme-roofing");
    assert.equal(sent.subject, WELCOME_SUBJECT);
    // The control plane sends WORDS. The sender is the relay's to decide and is not a request field.
    assert.equal("from" in sent, false, "the control plane must never name the From; the relay owns it");
    assert.equal(String(sent.idempotencyKey ?? "").startsWith("welcome:acme-roofing:"), true, String(sent.idempotencyKey));

    // ---- what the customer is actually told ------------------------------------------------------
    assert.match(sent.html, /Hi Jane,/);
    assert.match(sent.html, /Acme Roofing/);
    assert.match(sent.html, /Open your workspace/);
    assert.equal(sent.text.length > 200, true, "a plain-text alternative ships with every send");
    // Titan's own address, read out of the control plane's directory in step 4 and carried into the
    // mail. The sweep minted agent-titan's code, so this is the address that actually routes.
    const titan = plane.store.listMailAddresses("acme-roofing").find((row) => row.agentId === TITAN.id);
    assert.notEqual(titan, undefined, "step 4 has to leave a real address behind");
    assert.equal(sent.html.includes(titan.address), true, `the mail must name Titan's own address, ${titan.address}`);
    assert.equal(sent.text.includes(titan.address), true, "the plain-text alternative too");
    // BOTH SHAPES SHIP, which is ONBOARD-3's reason for existing: there is no customer-facing
    // set-a-password door, so a link-only mail locks them out at hour 25.
    assert.equal(sent.html.includes(password), true, "the temporary password ships in the mail as well as on the card");
    assert.equal(sent.html.includes("jane@acmeroofing.com"), true, "and the mail says which address to sign in with");

    // ---- the sign-in link is a real one the relay would accept -----------------------------------
    const link = /https:\/\/[^"'\s]*\/login\?sso=([A-Za-z0-9._-]+)/.exec(sent.html);
    assert.notEqual(link, null, "the button has to carry a sign-in link");
    const verdict = verifySessionToken(link[1], tenantSessionSecret(plane.config.sessionSecret, "acme-roofing"));
    assert.equal(verdict.ok, true, `the relay would refuse this link: ${verdict.reason}`);
    assert.equal(verdict.payload.email, "jane@acmeroofing.com");
    assert.equal(verdict.payload.tenant, "acme-roofing");
    // A workspace's key is derived per tenant, which is what stops a customer who can read their own
    // relay's environment minting a link into somebody else's box.
    assert.equal(verifySessionToken(link[1], tenantSessionSecret(plane.config.sessionSecret, "stays")).ok, false);
    const life = Number(verdict.payload.exp) - Number(verdict.payload.iat);
    assert.equal(life, 24 * 60 * 60 * 1000, `the link lives ${life}ms and 24 hours is a ceiling, not a target`);

    // ---- the row holds who, whom, when and the provider id, and neither secret --------------------
    const rows = await plane.request("GET", "/v1/admin/clients/acme-roofing/welcome");
    assert.equal(rows.status, 200, rows.text);
    assert.equal(rows.body.read, true);
    assert.equal(rows.body.rows.length, 1);
    assert.equal(rows.body.rows[0].to, "operator@titaniumcomputing.com");
    assert.equal(rows.body.rows[0].outcome, "sent");
    assert.equal(String(rows.body.rows[0].resendId).length > 0, true, "the provider's id is the proof a mail left");
    for (const [what, written] of [["the welcome rows", JSON.stringify(rows.body)], ["the step ledger", JSON.stringify(state.body)]]) {
      assert.equal(written.includes(password), false, `${what} must not hold the temporary password`);
      assert.equal(written.includes(link[1]), false, `${what} must not hold the sign-in link`);
    }

    // ---- and the box was READ and never prompted ------------------------------------------------
    // onboarding-state.ts marks a box done:true / "existing-box" FOR EVER if the first read finds a
    // prompted conversation, and resetOnboarding is 403 without SAND_TEST_HOOKS, so one smoke prompt
    // from here permanently destroys a customer's first-run interview with no error and no way back.
    // `health` is excluded deliberately: provisionTenant's own waitForBox probe is a different
    // caller from this sequence and is not a gateway command.
    assert.deepEqual([...new Set(box.commands())].filter((one) => one !== "health").sort(),
      ["getOnboardingState", "listAgents"],
      "a fresh box may be READ and nothing else, for the whole life of this sequence");
  } finally {
    if (plane != null) await plane.dispose();
    if (relay != null) await relay.close();
    await coolify.close();
    await box.close();
  }
});

test("the real removal library, driven by the real admin route, runs its effects in order and frees the slug", async () => {
  const coolify = await startFakeCoolify();
  const containers = new Map();
  const relay = await startSeamRelay({ store: { mintMailCode: () => null }, containers, onHost: (name) => coolify.containerPresent(name) });
  // A REAL Coolify client over the fake server, because the removal's whole point is what Coolify
  // does and does not actually do. startAdminOnly leaves the client null unless it is handed one.
  const client = createCoolifyClient({
    config: loadConfig({
      COOLIFY_URL: coolify.url, COOLIFY_API_KEY: coolify.apiKey,
      COOLIFY_PROJECT_UUID: "project-uuid", COOLIFY_SERVER_UUID: "server-uuid",
    }),
  });
  const plane = await startAdminOnly({ relay, coolify, client });
  try {
    // The customer is built the way provisioning builds one: a Coolify service that has been
    // STARTED, so its container name is on the fake host, and a tenant row pointing at it.
    const service = await client.createService({ name: "titanbot-gone-soon", docker_compose_raw: "services:\n  titanbot-box:\n    image: x\n" });
    await client.startService(service.uuid);
    const container = boxContainerName(service.uuid);
    const built = plane.seedTenant({ slug: "gone-soon", name: "Gone Soon", status: "running", container });
    plane.store.updateTenant("gone-soon", { coolifyServiceUuid: service.uuid, boxContainer: container, boxReady: true });
    containers.set("gone-soon", container);
    plane.store.mintMailCode({ tenant: "gone-soon", agentId: TITAN.id, agentName: "Titan", domain: "myagents.email" });
    // A neighbour, so the removal can be shown to stay inside its own workspace.
    plane.seedTenant({ slug: "stays", name: "Stays" });
    plane.store.mintMailCode({ tenant: "stays", agentId: "agent-other", agentName: "Titan", domain: "myagents.email" });
    const tree = await relay.seedTree("gone-soon");

    // The confirm panel says what is about to happen, before anything happens.
    const plan = await plane.request("GET", "/v1/admin/clients/gone-soon/removal");
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.body.read, true, `the plan could not be read, so the adapter is wrong: ${plan.text}`);
    assert.equal(plan.body.status, "ready", plan.text);
    assert.equal(plan.body.addresses, 1, "the panel counts the addresses this workspace's bots hold");
    assert.equal(relay.callsTo("/tenant/purge").length, 0, "a plan deletes nothing and asks nothing destructive");

    // A mismatched typed name has NO effect at all, not even a stop.
    const wrong = await plane.request("DELETE", "/v1/admin/clients/gone-soon", { body: { confirm: "gone-soo" } });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(plane.store.getTenant("gone-soon") != null, true, "a refused removal must be indistinguishable from never asking");

    const removed = await plane.request("DELETE", "/v1/admin/clients/gone-soon", { body: { confirm: "gone-soon", deleteData: true } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.containerGone, true, removed.text);
    assert.equal(String(removed.body.provedBy).length > 0, true, "the removal has to say WHAT proved the container gone, not just that it is");

    // The order is the part that matters, so it is asserted as an order and not as a set.
    const steps = removed.body.effects.map((one) => one.step);
    const wanted = ["disable-signins", "addresses", "stop", "service", "container-gone"];
    assert.deepEqual(steps.filter((one) => wanted.includes(one)), wanted, `the effects landed out of order: ${steps.join(" > ")}`);
    assert.equal(steps.indexOf("data") > steps.indexOf("container-gone"), true,
      "the data may only go after the container was PROVED gone, or it is deleted out from under a box still holding the customer's gateway token");

    // The purge named the slug and NOTHING ELSE. The relay resolves the path from its own tenant
    // root; a route that took a path from its caller is a route that one day removes the wrong tree.
    const purges = relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
    assert.equal(purges.length, 1, "one destructive purge");
    assert.equal("path" in purges[0].body, false, "the control plane never sends the relay a path");
    assert.equal("dir" in purges[0].body, false, "nor a dir");
    // And it carried the two fields the REAL route refuses to work without. This is the contract the
    // first version of this file could not see, because its purge answer was hand-written in the
    // caller's own wrong shape: `{slug}` alone is a 400 from ui/purge-edge.mjs and deletes nothing.
    assert.equal(purges[0].body.confirm, "gone-soon", "the purge has to name the workspace in confirm");
    assert.equal(purges[0].body.container, container, "and carry the container, because the relay's registry has already forgotten it");
    assert.equal(removed.body.dataDeleted, true, removed.text);
    assert.equal(removed.body.bytesFreed, 6_200_000, removed.text);
    assert.equal(existsSync(tree), false, "the real route removed the real tree");

    // ONE CUSTOMER'S REMOVAL NEVER PRUNES THE WHOLE SERVER. cp/provision.mjs used to send
    // docker_cleanup=true, which dispatches Coolify's CleanupDocker across a host that also runs
    // ampcortex, anvil, Coolify's own stack and about twenty other things.
    const deletes = coolify.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/api/v1/services/"));
    assert.equal(deletes.length, 1, `expected one service delete, got ${deletes.length}`);
    assert.equal(String(deletes[0].query?.docker_cleanup), "false", JSON.stringify(deletes[0].query));
    assert.equal(String(deletes[0].query?.delete_volumes), "false", JSON.stringify(deletes[0].query));

    // The slug is GENUINELY free afterwards, which is what lets the same company be added again.
    assert.equal(plane.store.getTenant("gone-soon"), null);
    assert.deepEqual(plane.store.listAccountsForTenant("gone-soon"), []);
    assert.equal(plane.store.listMailAddresses("gone-soon").every((row) => row.state === "retired"), true,
      "every address a removed workspace held must be retired: no sweep can ever reach a box that no longer exists, so an address left active routes for ever");
    // And the neighbour is untouched.
    assert.equal(plane.store.listMailAddresses("stays").every((row) => row.state === "active"), true,
      "a removal must stay inside its own workspace");
    void built;
  } finally { await plane.dispose(); await relay.close(); await coolify.close(); }
});
