// MODEL-1. A customer moving their OWN workspace between the plans it is entitled to.
//
// The switch itself has existed since PROXY-1 and only the super admin could reach it: the door is
// /admin/tenants/<slug>/use-included, behind CP_RELAY_TOKEN, with the workspace in the path. That
// shape is right for an operator moving somebody else and unusable for a customer moving
// themselves, so entitling a workspace to a second plan and then letting them choose it meant a
// human on an ssh session every time.
//
// What is measured here is the pair of customer routes and, more than either of them, the two
// things that make them safe:
//
//   THE WORKSPACE COMES FROM THE SESSION. Nothing in a URL or a body names one. The last test in
//   this file signs in as one customer, asks for the other's model by every shape a body could
//   carry, and measures that the other box was never written.
//
//   THE ENTITLEMENT IS THE INCLUDED SET. The control plane narrows a workspace's included set to
//   what its own key may call, so a plan it is not entitled to is not in the array and the switch
//   answers 404 -- the same refusal the door already gave a model the proxy does not serve. There
//   is no second list here to go stale against the first.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { signInAsTenant, startRelayWithLinks, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";
import { boxStub, includedSet } from "./relay-proxy-support.mjs";

// A proxy that answers /models, so the probe the plan rows share has something to reach. Nothing in
// this file reads it; it exists so a reachable-looking console is not a second variable.
function startFakeProxy() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "plan-zai" }, { id: "plan-qwen" }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    stop: () => new Promise((done) => server.close(done)),
  })));
}

// ENTITLED TO TWO OF THE THREE, which is the state this whole wave exists to serve: the control
// plane has narrowed this workspace's key to plan-zai and plan-qwen, so plan-minimax is a plan the
// proxy serves, that this customer may not run, and that must not be reachable from their console.
//
// plan-qwen carries the vision facts: it cannot take a screenshot and names where one goes instead.
// That pair is the only thing on the card that a customer could not work out for themselves, so it
// is measured on the route rather than left to the page.
function entitledSet(options) {
  const set = includedSet(options);
  const rows = set.models.filter((row) => row.id !== "plan-minimax").map((row) => (row.id === "plan-qwen"
    ? { ...row, modelLabel: "Qwen3", supportsVision: false, visionFallback: "plan-zai-vision", visionFallbackLabel: "GLM-4.6V" }
    : { ...row, modelLabel: "GLM-5.3", supportsVision: true }));
  return { ...set, models: rows };
}

async function startConsole({ extra = [] } = {}) {
  const proxy = await startFakeProxy();
  const demo = tenantRow("demo");
  const others = extra.map((slug) => tenantRow(slug));
  const stub = boxStub([demo.row.box, ...others.map((one) => one.row.box)]);
  const relay = await startRelayWithLinks({
    SAND_UI_TENANTS_FILE: tenantsFile([
      { ...demo.row, included: entitledSet({ baseUrl: proxy.url, key: "sk-virtual-for-demo-only" }) },
      ...others.map((one) => ({ ...one.row, included: entitledSet({ baseUrl: proxy.url, key: `sk-virtual-for-${one.row.slug}` }) })),
    ]),
    ...stub.env,
  }, { prefix: "relay-model-switch-", pathValue: stub.pathValue });
  return { relay, demo, others, proxy, stub };
}

const plans = (relay, cookie) => fetch(`${relay.base}/model/plans`, { headers: { cookie } });
const use = (relay, cookie, body) => fetch(`${relay.base}/model/use`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
});

test("a signed-in customer is offered the plans their own workspace may run, and nothing else", async () => {
  const { relay, proxy, stub } = await startConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    const body = await (await plans(relay, cookie)).json();

    assert.equal(body.slug, "demo");
    assert.deepEqual(body.plans.map((row) => row.model), ["plan-zai", "plan-qwen"],
      "the offer is the workspace's own included set, which the control plane has already narrowed to its key");

    // The words a person reads, beside the string this route takes back. The alias is never the
    // label: a card drawn from `model` would print "plan-zai" at a customer.
    const byId = Object.fromEntries(body.plans.map((row) => [row.model, row]));
    assert.equal(byId["plan-zai"].modelLabel, "GLM-5.3");
    assert.equal(byId["plan-zai"].servedBy, "Z.AI");
    assert.equal(byId["plan-qwen"].modelLabel, "Qwen3");

    // MODEL-1's own field. A model that cannot take a screenshot says so and says where one goes,
    // in the words somebody gave that route rather than its alias.
    assert.equal(byId["plan-qwen"].vision.supported, false);
    assert.equal(byId["plan-qwen"].vision.fallback, "plan-zai-vision");
    assert.equal(byId["plan-qwen"].vision.fallbackLabel, "GLM-4.6V");
    assert.equal(byId["plan-zai"].vision.supported, true);

    // Nothing on this answer is a credential, under any name. The virtual key reaches the plans and
    // never a browser, which is the rule GET /endpoints already follows.
    assert.equal(JSON.stringify(body).includes("sk-virtual"), false);

    // Which one it is on, read the way the host resolves it. The box has been written to by this
    // point only if something else wrote it, so the honest answer here is none.
    assert.equal(body.current, null);
    assert.equal(body.pinned, false);

    // And once the box is pointed somewhere, the current row is marked rather than merely listed.
    stub.writeSecrets("titanbot-box-demo", { SAND_OPENAI_COMPATIBLE_MODEL: "plan-qwen" });
    const after = await (await plans(relay, cookie)).json();
    assert.equal(after.current, "plan-qwen");
    assert.deepEqual(after.plans.filter((row) => row.current).map((row) => row.model), ["plan-qwen"]);
  } finally { relay.stop(); await proxy.stop(); }
});

test("choosing one of them writes that customer's own box, and it takes effect on the next message", async () => {
  const { relay, proxy, stub } = await startConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    const response = await use(relay, cookie, { model: "plan-qwen" });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.model, "plan-qwen");
    assert.equal(body.modelLabel, "Qwen3");
    assert.equal(body.appliesFrom, "next message");

    // THE BOX, not a record of intent. Seven names go in together -- the address, the model, the
    // endpoint name, the credential, what the box tells a person it answers through and what it
    // tells them it is -- because a box that moved its address and kept its old label is a box
    // telling its customer it runs something it does not.
    const secrets = stub.secretsOf("titanbot-box-demo");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_MODEL, "plan-qwen");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_MODEL_LABEL, "Qwen3");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_SERVED_BY, "Qwen");
    assert.equal(secrets.SAND_OPENAI_COMPATIBLE_API_KEY, "sk-virtual-for-demo-only");

    // The answer names no file on this server and no variable. Those belong to the operator's own
    // door; what comes back here is a model, its name, and whether the write will take.
    assert.equal(Object.hasOwn(body, "rollbackFile"), false);
    assert.equal(Object.hasOwn(body, "wrote"), false);

    // And back again, which is the half a one-way switch would pass without.
    assert.equal((await use(relay, cookie, { model: "plan-zai" })).status, 200);
    assert.equal(stub.secretsOf("titanbot-box-demo").SAND_OPENAI_COMPATIBLE_MODEL, "plan-zai");
  } finally { relay.stop(); await proxy.stop(); }
});

test("a plan this workspace is not entitled to is refused, and the box is not touched", async () => {
  const { relay, proxy, stub } = await startConsole();
  try {
    const cookie = await signInAsTenant(relay, "demo");
    await use(relay, cookie, { model: "plan-zai" });

    // plan-minimax is a real plan model this proxy serves. It is not on this workspace's key, so
    // it is not in its included set, so this is a 404 and not a 403: from here that plan does not
    // exist. The workspace's own key would refuse it at the first message either way, which is the
    // failure this refusal exists to move forward to the button press.
    const refused = await use(relay, cookie, { model: "plan-minimax" });
    assert.equal(refused.status, 404);
    assert.match(String((await refused.json()).error), /no included model named plan-minimax/);

    // A model that is not a plan at all, and a body with no model on it. The empty one is the one
    // that matters: the shared door takes the first row when it is handed nothing, which is the
    // right default for a migration command and a silent wrong answer for a person pressing a
    // button whose choice went missing on the way here.
    assert.equal((await use(relay, cookie, { model: "gpt-4" })).status, 404);
    const empty = await use(relay, cookie, {});
    assert.equal(empty.status, 400);
    assert.match(String((await empty.json()).error), /name the model/);

    // Nothing moved through any of that.
    assert.equal(stub.secretsOf("titanbot-box-demo").SAND_OPENAI_COMPATIBLE_MODEL, "plan-zai");
  } finally { relay.stop(); await proxy.stop(); }
});

test("neither route answers a stranger, and neither takes a workspace from the browser", async () => {
  const { relay, proxy, stub } = await startConsole({ extra: ["rival"] });
  try {
    // Signed out: both doors are the console's own gate, which is a 401 and a login page rather
    // than a refusal shaped like a model that does not exist.
    assert.equal((await fetch(`${relay.base}/model/plans`)).status, 401);
    assert.equal((await fetch(`${relay.base}/model/use`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "plan-zai" }),
    })).status, 401);
    assert.equal(stub.secretsOf("titanbot-box-rival").SAND_OPENAI_COMPATIBLE_MODEL, undefined);

    // Signed in as demo, asking for rival by every name a body could carry it under. The workspace
    // is `t`, resolved once from the session's own tenant claim, and no field below is read at all.
    const cookie = await signInAsTenant(relay, "demo");
    for (const body of [
      { model: "plan-qwen", slug: "rival" },
      { model: "plan-qwen", tenant: "rival" },
      { model: "plan-qwen", workspace: "rival" },
    ]) {
      assert.equal((await use(relay, cookie, body)).status, 200);
      assert.equal(stub.secretsOf("titanbot-box-rival").SAND_OPENAI_COMPATIBLE_MODEL, undefined,
        `a body naming another workspace wrote into it: ${JSON.stringify(body)}`);
      assert.equal(stub.secretsOf("titanbot-box-demo").SAND_OPENAI_COMPATIBLE_MODEL, "plan-qwen");
    }

    // And the read answers about the session's workspace whatever is asked of it.
    const mine = await (await plans(relay, cookie)).json();
    assert.equal(mine.slug, "demo");

    // The wrong method on either door is a refusal rather than the other door's behaviour.
    assert.equal((await fetch(`${relay.base}/model/plans`, { method: "POST", headers: { cookie } })).status, 405);
    assert.equal((await fetch(`${relay.base}/model/use`, { headers: { cookie } })).status, 405);
  } finally { relay.stop(); await proxy.stop(); }
});
