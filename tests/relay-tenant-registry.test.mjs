// ui/tenant-registry.mjs on its own: which workspaces this console serves, and how it decides.
//
// The relay tests around this one stand a real server up and prove the isolation end to end. This
// one holds the module still and measures the rules that are easy to get subtly wrong and hard to
// see from outside:
//
//   - the operator is seeded from the environment, so a console with no control plane has exactly
//     one workspace and behaves as it always did;
//   - a control plane that returns a row for the operator has its box, token, gateway and
//     directories dropped rather than merged, so a wrong field there can never point Jason's
//     console at somebody else's box, while the two fields this relay cannot build for itself --
//     the included set and the derived session key -- are merged on;
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
  // Empty as a SEED, not as an answer (SIGNIN-2). The master that derives this key never leaves the
  // control plane, so there is nothing here to derive it from and a refresh merges the one the
  // control plane derived. Until then the instance password is the only door to this workspace.
  assert.equal(entry.sessionKey, "");
  // And with nothing set, the developer Mac's default, which is what it has always been.
  assert.equal(operatorEntry({ env: {}, gateway: "g", token: "t" }).box, "grok-bot-local-vm");
});

test("the control plane's workspaces join the operator's, and a row for the operator is dropped", async () => {
  // sessionKey emptied on the operator's row on purpose, so this stays a test of the row being
  // dropped and of the line that says so. A row carrying a key has something worth merging and is
  // deliberately silent; that is SIGNIN-2's own test below.
  const cp = fakeCp([{ body: { tenants: [row("demo"), row(OPERATOR_SLUG, { box: "somebody-elses-box", token: "not-the-operators", sessionKey: "" })] } }]);
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
  assert.equal(registry.get(OPERATOR_SLUG).gateway, "http://titanbot-box:1340");
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

test("somebody else's adopted workspace, a slug and a key and no box, answers not available", async () => {
  // SIGNIN-2 widened what the control plane answers: an ADOPTED workspace now gets a row carrying
  // its slug and its derived key even when this server holds no token or box for it. The operator's
  // own slug is the one that matters, but a second adopted workspace would arrive the same way, and
  // it must not become an entry pointing at nothing. Its box normalises to "", which is not a
  // container on this host, so it is marked unreachable and every route answers the sentence -- the
  // same answer it gets today by being left out of the registry altogether.
  const cp = fakeCp([{ body: { tenants: [{ slug: "second", sessionKey: "a-derived-key-for-second" }] } }]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    dockerNames: async () => new Set(["titanbot-box-jason"]),
    log: (line) => said.push(line),
  });
  await registry.refresh();

  const second = registry.get("second");
  assert.equal(second.box, "");
  assert.equal(second.gateway, "", "a gateway built from an empty box name would be a nonsense URL");
  assert.equal(second.token, "");
  assert.equal(second.reachable, false, "a workspace with no container here must answer the sentence");
  assert.ok(said.some((line) => line.includes("second: no container named (unset)")), said.join("\n"));
  // The operator's own is untouched by the neighbour, and still reachable by the exemption.
  assert.equal(registry.get(OPERATOR_SLUG).reachable, true);
  assert.equal(registry.get(OPERATOR_SLUG).box, "titanbot-box-jason");
});

test("that adopted workspace is still not available when docker cannot be asked", async () => {
  // The arm above proves it with docker answering. This one is the case that actually bites: the
  // docker sweep learns nothing (no docker on this relay, or a `docker ps` that failed), so if the
  // sweep were the only thing marking an entry unreachable, a row carrying a slug and a real
  // derived key and no box would stay reachable and hand that person a session into a console with
  // no box behind it. An empty box name is judged without docker.
  const cp = fakeCp([{ body: { tenants: [{ slug: "second", sessionKey: "a-derived-key-for-second" }] } }]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    dockerNames: async () => null,
    log: (line) => said.push(line),
  });
  await registry.refresh();

  assert.equal(registry.get("second").reachable, false, "no box name is no workspace, docker or no docker");
  assert.ok(said.some((line) => line.includes("second: no container named (unset)")), said.join("\n"));
  // And the operator is untouched: its own key and box come from this relay's environment, and it
  // is never marked unreachable by anything.
  assert.equal(registry.get(OPERATOR_SLUG).reachable, true);
  assert.equal(registry.get(OPERATOR_SLUG).box, "titanbot-box-jason");
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


// ---- PROXY-1: the included set on an entry -----------------------------------------------------
//
// One field, and three rules that decide whether a console is safe to point at a proxy at all:
// absent is a real answer, a re-minted key rebuilds the entry, and the operator's own row is the
// single exception to "never merge a control plane row onto the seed" -- because Jason's workspace
// is a tenant of the proxy like everybody else and his box is one of the three the copied operator
// key is leaving.
import { includedSet } from "./relay-proxy-support.mjs";

test("an included set is normalised, and anything unusable in it is no set at all", async () => {
  const cp = fakeCp([{ body: { tenants: [
    row("full", { included: includedSet({ key: "sk-full" }) }),
    // A trailing slash on the base URL would double every path the box builds from it.
    row("slash", { included: { baseUrl: "http://titanbot-proxy:4000/v1/", key: "k", models: [{ model: "plan-zai" }] } }),
    // No key, so there is no way to use it: not a degraded set, no set.
    row("keyless", { included: { baseUrl: "http://titanbot-proxy:4000/v1", models: [{ model: "plan-zai" }] } }),
    // No models, same answer.
    row("modelless", { included: { baseUrl: "http://titanbot-proxy:4000/v1", key: "k", models: [] } }),
    // Shapes a wrong control plane could send. None of them becomes a half-built set.
    row("wrong", { included: "yes" }),
    row("listy", { included: [1, 2] }),
    row("none"),
  ] } }]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();

  const full = registry.get("full").included;
  assert.equal(full.baseUrl, "http://titanbot-proxy:4000/v1");
  assert.equal(full.key, "sk-full");
  assert.equal(full.enforced, false, "observe mode is the default, and absent means observe");
  assert.deepEqual(full.models.map((m) => m.id), ["plan-zai", "plan-minimax", "plan-qwen"]);
  // id EQUALS model. One string, pinned by the design, so nothing downstream can carry two.
  for (const m of full.models) assert.equal(m.id, m.model);
  assert.equal(full.models[0].contextWindow, 200000);
  assert.equal(full.models[0].servedBy, "Z.AI");

  assert.equal(registry.get("slash").included.baseUrl, "http://titanbot-proxy:4000/v1");
  // A row given only a model name still resolves: the id is the model.
  //
  // PROVIDERS-1 adds modelLabel to this shape, and an empty string is the honest answer for a row
  // that carries none: it means "nobody has named this model", which ui/server.mjs turns into no
  // SAND_OPENAI_COMPATIBLE_MODEL_LABEL in the box and the console renders as the model itself. The
  // field is normalised in rather than left off precisely so no reader downstream has to ask
  // whether it might be missing -- which is the mistake that lost the label in the first place.
  assert.deepEqual(registry.get("slash").included.models, [
    { id: "plan-zai", model: "plan-zai", name: "plan-zai", contextWindow: null, servedBy: "", modelLabel: "" },
  ]);

  // Absent is a real answer, and every unusable shape lands on it. This is what keeps a developer
  // Mac and a single-box install byte-identical to today.
  for (const slug of ["keyless", "modelless", "wrong", "listy", "none"]) {
    assert.equal(registry.get(slug).included, null, `${slug} should carry no included set`);
  }
});

test("a re-minted key rebuilds the entry, so the console stops handing out the old one", async () => {
  const first = includedSet({ key: "sk-before" });
  const cp = fakeCp([
    { body: { tenants: [row("demo", { included: first })] } },
    { body: { tenants: [row("demo", { included: first })] } },
    { body: { tenants: [row("demo", { included: includedSet({ key: "sk-after" }) })] } },
    { body: { tenants: [row("demo")] } },
  ]);
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp, log: () => {},
  });
  await registry.refresh();
  const before = registry.get("demo");
  await registry.refresh();
  assert.equal(registry.get("demo"), before, "an unchanged key must not churn the cached context");
  await registry.refresh();
  assert.notEqual(registry.get("demo"), before, "a re-minted key has to invalidate it");
  assert.equal(registry.get("demo").included.key, "sk-after");
  // Revocation is the same movement in the other direction: the set goes away and the entry moves.
  await registry.refresh();
  assert.equal(registry.get("demo").included, null);
});

test("the operator's row is still dropped, except for the two fields this relay cannot build itself", async () => {
  const included = includedSet({ key: "sk-for-jason" });
  const cp = fakeCp([
    { body: { tenants: [row(OPERATOR_SLUG, {
      box: "somebody-elses-box", token: "not-the-operators", gateway: "http://somebody-else:1340",
      sessionKey: "the-key-only-the-control-plane-can-derive",
      stateDir: "/somebody/else/state", profileDir: "/somebody/else/profile",
      included,
    })] } },
    { body: { tenants: [row(OPERATOR_SLUG, { box: "somebody-elses-box", sessionKey: "" })] } },
  ]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    log: (line) => said.push(line),
  });
  await registry.refresh();

  const seed = registry.get(OPERATOR_SLUG);
  // Everything a wrong control plane field could have moved is still this relay's own environment.
  assert.equal(seed.box, "titanbot-box-jason");
  assert.equal(seed.token, "operator-gateway-token");
  assert.equal(seed.gateway, "http://titanbot-box:1340");
  assert.equal(seed.stateDir, "/state");
  assert.equal(seed.profileDir, "/profile");
  // And the two fields that could only have come from the control plane did. `included` is minted
  // at the proxy and `sessionKey` is derived from a master that never leaves that service, so there
  // is nothing in this relay's environment to build either one from: they are the whole of what a
  // row for this slug is allowed to move, and box, token, gateway and the two directories above are
  // the whole of what it is not.
  assert.equal(seed.included.key, "sk-for-jason");
  assert.deepEqual(seed.included.models.map((m) => m.id), ["plan-zai", "plan-minimax", "plan-qwen"]);
  assert.equal(seed.sessionKey, "the-key-only-the-control-plane-can-derive",
    "SIGNIN-2: without this an account on the operator's own workspace cannot be verified at all");
  assert.equal(registry.sessionKeyOf(OPERATOR_SLUG), "the-key-only-the-control-plane-can-derive",
    "the lookup the sign-in actually calls is the one that has to answer");
  assert.equal(said.some((line) => line.includes("uses its own environment")), false,
    "a row carrying something worth merging is not a fault to report every sixty seconds");

  // Turning either one off on the control plane turns it off here, rather than leaving a dead value
  // on Jason's console; and THAT row, with nothing on it at all, is the one worth a line.
  await registry.refresh();
  assert.equal(registry.get(OPERATOR_SLUG).included, null);
  assert.equal(registry.get(OPERATOR_SLUG).sessionKey, "");
  assert.equal(registry.get(OPERATOR_SLUG).box, "titanbot-box-jason");
  assert.equal(said.some((line) => line.includes("uses its own environment")), true);
});

test("a row for the operator carrying only a derived key merges it, says nothing, and moves no other field", async () => {
  // SIGNIN-2, and this is the normal live shape: the control plane answers the operator's slug with
  // {slug, sessionKey} and no included set, because the proxy is off on that server. The key has to
  // arrive, and the sixty-second log line must NOT -- a line that reads as a fault on a console that
  // is working perfectly is the exact failure PROXY-1 already fixed once.
  const key = "a-derived-key-for-the-operators-own-workspace";
  const customer = row("demo");
  const cp = fakeCp([
    { body: { tenants: [{ slug: OPERATOR_SLUG, sessionKey: key }, customer] } },
    { body: { tenants: [{ slug: OPERATOR_SLUG }, customer] } },
  ]);
  const said = [];
  const registry = createTenantRegistry({
    operator: OPERATOR, cpUrl: "https://api.titanium.bot", relayToken: "a-relay-token", ...cp,
    log: (line) => said.push(line),
  });
  await registry.refresh();

  const seed = registry.get(OPERATOR_SLUG);
  assert.equal(seed.sessionKey, key);
  assert.equal(seed.included, null, "there was no included set on the row and none was invented");
  // The env seed, field for field. A row this thin is exactly the one that could quietly blank them.
  assert.equal(seed.box, "titanbot-box-jason");
  assert.equal(seed.token, "operator-gateway-token");
  assert.equal(seed.gateway, "http://titanbot-box:1340");
  assert.equal(seed.stateDir, "/state");
  assert.equal(seed.profileDir, "/profile");
  assert.equal(seed.operator, true);
  assert.deepEqual(said, [], `a working console logged something: ${said.join(" | ")}`);

  // A later row with neither field clears both and says so, once.
  await registry.refresh();
  assert.equal(registry.get(OPERATOR_SLUG).sessionKey, "");
  assert.equal(registry.get(OPERATOR_SLUG).included, null);
  assert.equal(said.filter((line) => line.includes("uses its own environment")).length, 1);

  // And the customer in the same answer is untouched by any of it, field for field.
  const demo = registry.get("demo");
  for (const field of ["slug", "name", "box", "gateway", "token", "sessionKey", "stateDir", "profileDir", "status"]) {
    assert.equal(demo[field], customer[field], `the customer's ${field} moved`);
  }
  assert.equal(demo.operator, false);
});

test("a console with no control plane has no included set anywhere, and never asks for one", async () => {
  const registry = createTenantRegistry({ operator: OPERATOR, log: () => {} });
  await registry.refresh();
  assert.equal(registry.operator().included, null);
  assert.equal(operatorEntry({ env: {}, gateway: "g", token: "t" }).included, null);
});
