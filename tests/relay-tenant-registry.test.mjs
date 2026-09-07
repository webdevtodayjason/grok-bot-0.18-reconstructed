// ui/tenant-registry.mjs on its own: which workspaces this console serves, and how it decides.
//
// The relay tests around this one stand a real server up and prove the isolation end to end. This
// one holds the module still and measures the rules that are easy to get subtly wrong and hard to
// see from outside:
//
//   - the operator is seeded from the environment, so a console with no control plane has exactly
//     one workspace and behaves as it always did;
//   - a control plane that returns a row for the operator is dropped, not merged, so a wrong field
//     there can never point Jason's console at somebody else's box;
//   - a refresh that fails keeps the last good answer instead of emptying the console;
//   - a box name is verified against what is actually running, and never guessed;
//   - the operator is exempt from being marked unavailable, because this console is the door a
//     stopped box gets fixed from;
//   - a token scan compares every entry with no early break.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NOT_AVAILABLE_SENTENCE, OPERATOR_SLUG, createTenantRegistry, operatorEntry, tenantFile,
} from "../ui/tenant-registry.mjs";
import { stateFile } from "../ui/state-dir.mjs";

const OPERATOR = {
  slug: OPERATOR_SLUG, name: "Titanium", box: "titanbot-box-jason",
  gateway: "http://titanbot-box:1340", token: "operator-gateway-token",
  sessionKey: "", stateDir: "/state", profileDir: "/profile", status: "running",
};

const row = (slug, extra = {}) => ({
  slug, name: slug, box: `titanbot-box-${slug}`, gateway: `http://titanbot-box-${slug}:1340`,
  token: `${slug}-gateway-token`, sessionKey: `${slug}-session-key`,
  stateDir: `/data/titanbot/${slug}/state`, profileDir: `/data/titanbot/${slug}/profile`,
  status: "running", ...extra,
});

// A control plane at the fetch, answering whatever it is told to and recording what it was asked.
function fakeCp(answers) {
  const calls = [];
  let at = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization ?? "" });
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer.throws) throw Object.assign(new Error("no answer"), { name: answer.throws });
    return {
      status: answer.status ?? 200,
      json: async () => {
        if (answer.body === undefined) throw new Error("not json");
        return answer.body;
      },
    };
  };
  return { fetchImpl, calls };
}

test("with no control plane the console holds exactly one workspace, the operator's", async () => {
  const registry = createTenantRegistry({ operator: OPERATOR, log: () => {} });
  await registry.refresh();
  assert.equal(registry.all().length, 1);
  assert.equal(registry.get(OPERATOR_SLUG).slug, OPERATOR_SLUG);
  assert.equal(registry.get(OPERATOR_SLUG).operator, true);
  assert.equal(registry.get(OPERATOR_SLUG).box, "titanbot-box-jason");
  assert.equal(registry.get("somebody-else"), null);
  // The whole compatibility story in one line: no CP_URL, no CP_RELAY_TOKEN, nothing is fetched.
  assert.equal(registry.operator().token, "operator-gateway-token");
});

test("the operator entry is built from the environment, not from anything a control plane sends", () => {
  const entry = operatorEntry({
    env: { SAND_BOX_CONTAINER: "titanbot-box-p927" },
    gateway: "http://titanbot-box:1340/", token: "tok", stateDir: "/state", profileDir: "/profile",
  });
  assert.equal(entry.slug, OPERATOR_SLUG);
  assert.equal(entry.box, "titanbot-box-p927");
  assert.equal(entry.gateway, "http://titanbot-box:1340", "a trailing slash would double every path");
  // Empty on purpose: the operator signs in with the instance password, and the master key that
  // would derive this one never leaves the control plane.
  assert.equal(entry.sessionKey, "");
  // And with nothing set, the developer Mac's default, which is what it has always been.
  assert.equal(operatorEntry({ env: {}, gateway: "g", token: "t" }).box, "grok-bot-local-vm");
});

test("the control plane's workspaces join the operator's, and a row for the operator is dropped", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo"), row(OPERATOR_SLUG, { box: "somebody-elses-box", token: "not-the-operators" })] } }]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token",
    ...cp, log: (line) => said.push(line),
  });
  await registry.refresh();

  assert.equal(cp.calls[0].url, "https://api.titanium.bot/v1/relay/tenants");
  assert.equal(cp.calls[0].authorization, "Bearer a-relay-token");
  assert.equal(registry.all().length, 2);
  assert.equal(registry.get("demo").token, "demo-gateway-token");
  assert.equal(registry.get("demo").sessionKey, "demo-session-key");
  // Dropped, not merged. A control plane with one field wrong would otherwise aim Jason's own
  // console at a customer's box, holding a customer's token.
  assert.equal(registry.get(OPERATOR_SLUG).box, "titanbot-box-jason");
  assert.equal(registry.get(OPERATOR_SLUG).token, "operator-gateway-token");
  assert.ok(said.some((line) => line.includes(`returned a row for ${OPERATOR_SLUG}`)), said.join("\n"));
});

test("a refresh that fails keeps the last good answer and says so once", async () => {
  const cp = fakeCp([
    { body: { tenants: [row("demo"), row("acme")] } },
    { throws: "TimeoutError" },
    { throws: "TimeoutError" },
    { status: 500 },
  ]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token",
    ...cp, log: (line) => said.push(line),
  });
  await registry.refresh();
  assert.equal(registry.all().length, 3);

  const failed = await registry.refresh();
  assert.equal(failed.ok, false);
  assert.equal(failed.detail, "timed out");
  assert.equal(registry.all().length, 3, "an outage must not empty the console");
  assert.equal(registry.get("demo").token, "demo-gateway-token");

  await registry.refresh();
  await registry.refresh();
  // Once per failure streak, not once a minute forever.
  const complaints = said.filter((line) => line.includes("could not reach the control plane"));
  assert.equal(complaints.length, 1, said.join("\n"));
  assert.match(complaints[0], /serving the 3 tenant\(s\)/);
});

test("an answer that is not a tenant list is a failure, not an empty console", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo")] } }, { body: { error: "who are you" } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();
  const second = await registry.refresh();
  assert.equal(second.ok, false);
  assert.equal(registry.get("demo").token, "demo-gateway-token");
});

test("a box name is verified against what is running, and the operator is never locked out over one", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo"), row("gone")] } }]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    // demo is running; gone is not, and neither is the operator's own.
    dockerNames: async () => new Set(["titanbot-box-demo", "some-unrelated-container"]),
    log: (line) => said.push(line),
  });
  await registry.refresh();

  assert.equal(registry.get("demo").reachable, true);
  assert.equal(registry.get("gone").reachable, false);
  assert.ok(said.some((line) => line.includes("gone: no container named titanbot-box-gone")), said.join("\n"));
  // The operator is exempt. This console is the door a stopped box gets fixed from, so it says so
  // in the log rather than answering the operator "not available" on every route.
  assert.equal(registry.get(OPERATOR_SLUG).reachable, true);
  assert.ok(said.some((line) => line.includes("Set SAND_BOX_CONTAINER")), said.join("\n"));
});

test("a docker that cannot be asked marks nothing unavailable", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo")] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    // No answer is not evidence of absence: a relay with no docker, or one whose docker hiccupped,
    // must not turn the whole console into "not available".
    dockerNames: async () => null,
    log: () => {},
  });
  await registry.refresh();
  assert.equal(registry.get("demo").reachable, true);
  assert.equal(registry.get(OPERATOR_SLUG).reachable, true);
});

test("the token scan compares every workspace and answers with the one that matches", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo"), row("acme")] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();

  assert.equal(registry.matchToken("demo-gateway-token").slug, "demo");
  assert.equal(registry.matchToken("acme-gateway-token").slug, "acme");
  assert.equal(registry.matchToken("operator-gateway-token").slug, OPERATOR_SLUG);
  assert.equal(registry.matchToken("a token nobody here holds"), null);
  assert.equal(registry.matchToken(""), null);
  assert.equal(registry.matchToken(null), null);

  // Every entry is asked, with no early break, so the time this takes says nothing about which
  // workspace matched or how many there are.
  const asked = [];
  const found = registry.matchBy("acme-gateway-token", (entry) => { asked.push(entry.slug); return entry.token; });
  assert.equal(found.slug, "acme");
  assert.deepEqual(asked.sort(), ["acme", "demo", OPERATOR_SLUG].sort());

  // A value that cannot be read is not a match and is not a crash: on the job bus this is a token
  // file that is missing or unreadable, which is simply a workspace with no bus.
  assert.equal(registry.matchBy("anything", () => { throw new Error("no such file"); }), null);
});

test("the override file is read instead of the control plane, which is what makes this testable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tenant-registry-"));
  const file = path.join(dir, "tenants.json");
  writeFileSync(file, JSON.stringify({ tenants: [row("demo")] }));
  const cp = fakeCp([{ body: { tenants: [row("never-read")] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token",
    tenantsFile: file, ...cp, log: () => {},
  });
  await registry.refresh();
  assert.equal(registry.get("demo").slug, "demo");
  assert.equal(registry.get("never-read"), null);
  assert.equal(cp.calls.length, 0, "the override must not also call the control plane");

  // The file is re-read on every refresh, so a gate can change the fleet under a running relay.
  writeFileSync(file, JSON.stringify({ tenants: [row("demo"), row("second")] }));
  await registry.refresh();
  assert.equal(registry.all().length, 3);

  // A file that cannot be read is an outage, not an empty console.
  writeFileSync(file, "{ not json");
  const failed = await registry.refresh();
  assert.equal(failed.ok, false);
  assert.equal(registry.all().length, 3);
});

test("an unknown workspace triggers one refresh, and not one per request", async () => {
  const cp = fakeCp([{ body: { tenants: [] } }]);
  let clock = 1_000_000;
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    now: () => clock, missRefreshMs: 10_000, log: () => {},
  });
  await registry.refresh();
  const before = cp.calls.length;

  // A customer who signed up thirty seconds ago should not wait a minute for the schedule.
  assert.equal(registry.miss("brand-new"), true);
  // A stranger with a made-up slug in a signed cookie must not be able to pump the control plane.
  assert.equal(registry.miss("brand-new"), false);
  assert.equal(registry.miss("another-made-up-one"), false);
  clock += 10_001;
  assert.equal(registry.miss("brand-new"), true);
  // A workspace we already have is never a miss.
  assert.equal(registry.miss(OPERATOR_SLUG), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cp.calls.length - before, 2);
});

test("an entry that did not change keeps its identity, so the per-workspace caches survive a refresh", async () => {
  const cp = fakeCp([{ body: { tenants: [row("demo")] } }, { body: { tenants: [row("demo")] } },
    { body: { tenants: [row("demo", { box: "titanbot-box-demo-2" })] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();
  const first = registry.get("demo");
  await registry.refresh();
  assert.equal(registry.get("demo"), first, "an unchanged workspace must not churn its cached context");
  await registry.refresh();
  assert.notEqual(registry.get("demo"), first, "a moved box must invalidate it");
  assert.equal(registry.get("demo").box, "titanbot-box-demo-2");
});

test("a row with no gateway falls back to its own box name on the shared network", async () => {
  const cp = fakeCp([{ body: { tenants: [{ slug: "demo", box: "titanbot-box-demo", token: "t" }] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();
  assert.equal(registry.get("demo").gateway, "http://titanbot-box-demo:1340");
  // And a row with no slug at all is not a workspace and is skipped rather than crashing the read.
  assert.equal(registry.all().length, 2);
});

test("a file goes to the operator's own resolution or to that workspace's state directory", () => {
  const operator = { operator: true, stateDir: "/state" };
  const tenant = { operator: false, stateDir: "/data/titanbot/demo/state" };
  // The operator keeps every override it ever had, which is what stateFile carries.
  assert.equal(tenantFile(operator, "endpoints.json", { here: "/app/ui", stateFile }),
    stateFile("endpoints.json", "/app/ui"));
  // A customer's comes out of its own directory and nowhere else.
  assert.equal(tenantFile(tenant, "endpoints.json", { here: "/app/ui" }), "/data/titanbot/demo/state/endpoints.json");
  // With no state directory at all, beside the code, which is the developer Mac.
  assert.equal(tenantFile({ operator: false, stateDir: "" }, "mail.json", { here: "/app/ui" }), "/app/ui/mail.json");
});

test("the sentence a person sees is one sentence, in plain words", () => {
  assert.equal(NOT_AVAILABLE_SENTENCE, "That workspace is not available right now.");
  assert.equal(NOT_AVAILABLE_SENTENCE.includes("--"), false, "no em dashes in copy a business owner reads");
});

test("the operator's own row being skipped by the control plane is not reported as a fault", async () => {
  // The control plane cannot serve the operator's row: an adoption holds a uuid and a host and no
  // token or directories, so it leaves that row out and says why. The relay builds that entry from
  // its own environment instead, so the skip is the arrangement working. Printing it made a healthy
  // console say something was wrong with itself every sixty seconds.
  const lines = [];
  const registry = createTenantRegistry({
    operator: operatorEntry({ env: { SAND_BOX_CONTAINER: "titanbot-box-operator" }, gateway: "http://box:1340", token: "t" }),
    cpUrl: "http://control-plane.invalid",
    relayToken: "a relay credential of at least thirty two characters",
    dockerNames: async () => null,
    log: (line) => lines.push(String(line)),
    fetchImpl: async () => new Response(JSON.stringify({
      tenants: [],
      skipped: [
        { slug: OPERATOR_SLUG, why: "this workspace has no gateway token on this server" },
        { slug: "halfway", why: "this workspace has no container yet" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await registry.refresh();
  assert.equal(lines.some((line) => line.includes(OPERATOR_SLUG)), false, `the operator's own skip was reported: ${lines.join(" | ")}`);
  assert.equal(lines.some((line) => line.includes("halfway")), true, "a real customer's skip must still be named");
  // And the operator is still served, which is the whole reason the skip is expected.
  assert.equal(registry.get(OPERATOR_SLUG)?.box, "titanbot-box-operator");
});
