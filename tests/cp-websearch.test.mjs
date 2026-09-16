// BASELINE-1, the control plane's half of piece 1: `websearch list` and `websearch set`.
//
// THE THING THIS SUITE EXISTS TO STOP. Measured on the R750 on 2026-09-08 and unchanged on
// 2026-09-15: the proxy's two TinyFish pass-throughs are configured and serve with an EMPTY
// x-api-key, because PROXY_TINYFISH_KEY_1 and PROXY_TINYFISH_KEY_2 hold zero characters. A command
// that points ten customers' boxes at those doors would replace "nothing is set up here", which is
// true and actionable, with a failure upstream on every question that books a metered request on the
// way. So the first case below is the refusal, and it asserts that no box was touched at all.
//
// THE FAKE BOX IS NOT A FICTION. Its two commands are built out of the REAL host modules -- the real
// describeWebSearchRoute, the real checkWebSearchRouteWrite, the real 0600 writer from
// connector-secrets.ts -- against a real temporary directory per workspace. Only the transport is
// fake, so a rule this suite passes is a rule the host really keeps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import {
  PROXY_TINYFISH_FETCH_PATH,
  PROXY_TINYFISH_SEARCH_PATH,
  createWebSearchProvisioner,
  judgeInBoxProof,
  judgeSearchAnswer,
  proxyTinyFishState,
  sha12,
  webSearchEndpointsFor,
  webSearchPlan,
} from "../cp/websearch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".cp-websearch-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const require_ = createRequire(import.meta.url);
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
};
const hostRoute = await bundle("source/host/extensions/inference/web-search-route.ts", "web-search-route.cjs");
const hostSecrets = await bundle("source/host/extensions/mcp/connector-secrets.ts", "connector-secrets.cjs");

const PROXY_URL = "http://titanbot-proxy:4000";
const ENDPOINTS = webSearchEndpointsFor(PROXY_URL);
/** Invented keys, of the shape a virtual key has. No real credential is anywhere in this file. */
const keyFor = (slug) => `sk-invented-${slug}-0000000000`;
const OPERATOR_KEY = "o".repeat(44);

/** The proxy's answer when both doors carry a credential. */
const liveDoors = () => ({
  ok: true,
  rows: [
    { path: PROXY_TINYFISH_FETCH_PATH, headerSet: { "x-api-key": true, "content-type": true } },
    { path: PROXY_TINYFISH_SEARCH_PATH, headerSet: { "x-api-key": true, "content-type": true } },
  ],
});
/** The R750 as measured: both doors mounted, both credentials empty. */
const deadDoors = () => ({
  ok: true,
  rows: [
    { path: PROXY_TINYFISH_FETCH_PATH, headerSet: { "x-api-key": false, "content-type": true } },
    { path: PROXY_TINYFISH_SEARCH_PATH, headerSet: { "x-api-key": false, "content-type": true } },
  ],
});

/**
 * A fleet of fake boxes. Each one is a real directory the real host writer writes into, so the
 * whole path -- plan, write, read back, idempotence -- runs against the host's own rules.
 */
function fleet(spec) {
  const roots_ = new Map();
  const calls = [];
  for (const [slug, setup] of Object.entries(spec)) {
    const root = mkdtempSync(path.join(tmpdir(), `cp-websearch-${slug}-`));
    roots.push(root);
    roots_.set(slug, { root, connectors: setup?.connectors ?? [], down: setup?.down === true });
    for (const [field, value] of Object.entries(setup?.section ?? {})) {
      hostSecrets.writeConnectorEnvSecret(root, "tinyfish", field, value);
    }
  }
  const sectionOf = (root) => hostSecrets.readConnectorEnvSecrets(root).tinyfish ?? null;
  const boxCall = async (slug, command, args = {}) => {
    calls.push({ slug, command, args });
    const box = roots_.get(slug);
    if (box == null) return { ok: false, why: `there is no workspace called ${slug}` };
    if (box.down) return { ok: false, why: `${command} did not answer (connect ECONNREFUSED)` };
    if (command === "getWebSearchRoute") {
      return { ok: true, body: hostRoute.describeWebSearchRoute(sectionOf(box.root), box.connectors) };
    }
    if (command === "setWebSearchRoute") {
      const checked = hostRoute.checkWebSearchRouteWrite(args);
      if (!checked.ok) return { ok: false, why: checked.why };
      const before = hostRoute.describeWebSearchRoute(sectionOf(box.root));
      const values = [
        [hostRoute.WEB_SEARCH_ROUTE_FIELDS[0], checked.write.apiKey],
        [hostRoute.WEB_SEARCH_ROUTE_FIELDS[1], checked.write.fetchEndpoint],
        [hostRoute.WEB_SEARCH_ROUTE_FIELDS[2], checked.write.searchEndpoint],
      ];
      for (const [field, value] of values) hostSecrets.writeConnectorEnvSecret(box.root, "tinyfish", field, value);
      const after = hostRoute.describeWebSearchRoute(sectionOf(box.root), box.connectors);
      return {
        ok: true,
        body: {
          ...hostRoute.webSearchRouteEvidence(checked.write),
          changed: before.keySha256 !== after.keySha256
            || before.fetchEndpoint !== after.fetchEndpoint
            || before.searchEndpoint !== after.searchEndpoint,
          route: after,
        },
      };
    }
    return { ok: false, why: `this fake box has no ${command}` };
  };
  return { boxCall, calls, sectionOf: (slug) => sectionOf(roots_.get(slug).root) };
}

/** A search address that answers like the real pass-through does. */
const searchFetch = (rows) => async () => ({
  status: 200,
  text: async () => JSON.stringify({ results: rows }),
});

function provisioner({ boxCall, passThrough = liveDoors(), tenants, fetchImpl = searchFetch([{ title: "Bolt Depot", url: "https://boltdepot.com" }]) }) {
  const lines = [];
  return {
    lines,
    api: createWebSearchProvisioner({
      tenants: tenants.map((slug) => ({ slug })),
      boxCall,
      proxy: { listPassThrough: async () => passThrough },
      keyOf: (slug) => keyFor(slug),
      proxyUrl: PROXY_URL,
      out: (line) => lines.push(line),
      fetchImpl,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
    }),
  };
}

// ------------------------------------------------------------------------------ the addresses

test("the two addresses are built off the proxy, and agree with the host's own constants", () => {
  assert.equal(ENDPOINTS.fetchEndpoint, "http://titanbot-proxy:4000/tinyfish/fetch");
  assert.equal(ENDPOINTS.searchEndpoint, "http://titanbot-proxy:4000/tinyfish/search");
  // CP_PROXY_URL carries /v1 on the R750 and loadConfig strips it. PROXY-1 shipped with that strip
  // missing and every box went to /v1/v1, so it is stripped here as well and pinned here.
  assert.deepEqual(webSearchEndpointsFor("http://titanbot-proxy:4000/v1"), ENDPOINTS);
  assert.deepEqual(webSearchEndpointsFor("http://titanbot-proxy:4000///"), ENDPOINTS);
  assert.equal(webSearchEndpointsFor(""), null);
  assert.equal(webSearchEndpointsFor(null), null);
  // THE THREE-PLACE PIN. The proxy mounts these paths, the host names them, this file writes them.
  // A control plane writing a path the proxy does not mount is a 404 on every customer's question.
  const source = require_("node:fs").readFileSync(path.join(repoRoot, "source/host/extensions/inference/tinyfish-route.ts"), "utf8");
  assert.ok(source.includes(`PROXY_TINYFISH_FETCH_PATH = "${PROXY_TINYFISH_FETCH_PATH}"`));
  assert.ok(source.includes(`PROXY_TINYFISH_SEARCH_PATH = "${PROXY_TINYFISH_SEARCH_PATH}"`));
});

// -------------------------------------------------------------------- the door with no key in it

test("a proxy whose TinyFish doors carry no credential is a refusal, with the fix named", () => {
  const state = proxyTinyFishState(deadDoors());
  assert.equal(state.ok, false);
  assert.match(state.why, /empty credential header/);
  assert.match(state.why, /book a metered request/, "the cost of getting this wrong is said, not implied");
  assert.match(state.fix, /PROXY_TINYFISH_KEY_1/, "and the operator is told what to set");
  assert.ok(!/[—–]/.test(`${state.why} ${state.fix}`), "no em dash in a sentence a person reads");
});

test("a proxy that cannot be asked is also a refusal, which is the opposite of tenantRoutesFor", () => {
  // tenantRoutesFor LEAVES the routes on when the list cannot be read, because taking a working door
  // away from a customer mid-turn over a proxy hiccup is worse than leaving it. This decides whether
  // to WRITE a new door into somebody's box, so the asymmetry is deliberate and is pinned here.
  const state = proxyTinyFishState({ ok: false, why: "the proxy did not answer in time (15000 ms)" });
  assert.equal(state.ok, false);
  assert.match(state.why, /did not answer in time/);
  assert.equal(proxyTinyFishState({ ok: true, rows: [] }).ok, false, "a proxy mounting no TinyFish door at all");
  assert.match(proxyTinyFishState({ ok: true, rows: [] }).why, /nothing to point a box at/);
});

test("content-type alone is not a credential", () => {
  const onlyType = {
    ok: true,
    rows: [
      { path: PROXY_TINYFISH_FETCH_PATH, headerSet: { "content-type": true } },
      { path: PROXY_TINYFISH_SEARCH_PATH, headerSet: { "content-type": true } },
    ],
  };
  assert.equal(proxyTinyFishState(onlyType).ok, false);
  assert.equal(proxyTinyFishState(liveDoors()).ok, true);
});

test("one live door and one dead one is still a refusal, and names the dead one", () => {
  const half = liveDoors();
  half.rows[0].headerSet["x-api-key"] = false;
  const state = proxyTinyFishState(half);
  assert.equal(state.ok, false);
  assert.match(state.why, /\/tinyfish\/fetch/);
  assert.ok(!state.why.includes("/tinyfish/search"), "the working door is not blamed");
});

// ---------------------------------------------------------------------------------- the plan

test("the plan stops rather than guessing when a workspace has no key or no box", () => {
  const route = { route: "none", keyLength: 0, keySha256: "", fetchEndpoint: "x", searchEndpoint: "y" };
  assert.match(webSearchPlan({ slug: "acme", route, key: null, endpoints: ENDPOINTS }).why, /proxy mint acme/);
  assert.match(webSearchPlan({ slug: "acme", route: null, key: "k", endpoints: ENDPOINTS }).why, /could not be asked/);
  assert.match(webSearchPlan({ slug: "acme", route, key: "k", endpoints: null }).why, /CP_PROXY_URL is not set/);
});

test("a box running the connector itself is left alone", () => {
  const plan = webSearchPlan({
    slug: "acme", key: keyFor("acme"), endpoints: ENDPOINTS,
    route: { route: "connector", keyLength: 0, keySha256: "", ...ENDPOINTS },
  });
  assert.equal(plan.action, "skip");
  assert.match(plan.why, /outranks this route/, "and the reason is the resolver's order, not a guess");
  // Skipping is not a clean pass. Measured on the R750 2026-09-15, demo, titanium and richard-avery
  // all run this connector, so all three answer on the operator's credential and none of their
  // questions is metered to the workspace that asked. The line has to say that out loud.
  assert.match(plan.why, /not metered|nothing it asks is metered/i, "the consequence of skipping is named");
  assert.match(plan.why, /PROXY-7/, "and whose job moving it is");
});

test("a box already holding its own key against both addresses is nothing to do", () => {
  const key = keyFor("acme");
  const plan = webSearchPlan({
    slug: "acme", key, endpoints: ENDPOINTS,
    route: { route: "api", keyLength: key.length, keySha256: sha12(key), ...ENDPOINTS },
  });
  assert.equal(plan.action, "already");
  assert.equal(plan.keySha256, sha12(key));
});

test("a box holding somebody else's key is a write, and the plan names what it replaces", () => {
  const plan = webSearchPlan({
    slug: "demo", key: keyFor("demo"), endpoints: ENDPOINTS,
    route: {
      route: "api", keyLength: 44, keySha256: sha12(OPERATOR_KEY),
      fetchEndpoint: "https://api.fetch.tinyfish.ai", searchEndpoint: "https://api.search.tinyfish.ai",
    },
  });
  assert.equal(plan.action, "write");
  const said = plan.changes.join(" ");
  assert.match(said, /holds a different key today \(44 characters, sha256 [0-9a-f]{12}\)/,
    "a length and a hash, which is what proxy migrate prints and what is safe on a shared terminal");
  assert.match(said, /search moves from https:\/\/api\.search\.tinyfish\.ai to http:\/\/titanbot-proxy:4000\/tinyfish\/search/);
  assert.ok(!said.includes(OPERATOR_KEY) && !said.includes(keyFor("demo")), "no key value in anything printed");
});

test("a box with nothing at all says so rather than reporting a replacement", () => {
  const plan = webSearchPlan({
    slug: "beta-33", key: keyFor("beta-33"), endpoints: ENDPOINTS,
    route: { route: "none", keyLength: 0, keySha256: "", fetchEndpoint: "https://api.fetch.tinyfish.ai", searchEndpoint: "https://api.search.tinyfish.ai" },
  });
  assert.equal(plan.action, "write");
  assert.match(plan.changes.join(" "), /holds no key at all today/);
});

// ------------------------------------------------------------------------------ the two proofs

test("a search that answers 200 with no results is not a proof", () => {
  // What a dead pass-through returns, and it is a 200. Counting the status would have called the
  // whole R750 fleet proved on a credential that opens nothing.
  assert.equal(judgeSearchAnswer({ status: 200, body: '{"results":[]}' }).ok, false);
  assert.match(judgeSearchAnswer({ status: 200, body: '{"results":[]}' }).why, /what an empty credential looks like/);
  assert.equal(judgeSearchAnswer({ status: 401, body: "" }).ok, false);
  assert.equal(judgeSearchAnswer({ status: 200, body: "<html>" }).ok, false);
  const good = judgeSearchAnswer({ status: 200, body: '{"results":[{"title":"Bolt Depot","url":"https://boltdepot.com"}]}' });
  assert.equal(good.ok, true);
  assert.equal(good.results, 1);
});

test("an in-box answer with no web tool row behind it is not a proof", () => {
  // A model answers a lookup question out of its own memory and the sentence reads identically. The
  // outline is the only place outside the box that says which tools a turn really called.
  assert.equal(judgeInBoxProof({ reply: "Node 24 is current.", toolNames: ["SendMessage"] }).ok, false);
  assert.match(judgeInBoxProof({ reply: "Node 24 is current.", toolNames: [] }).why, /came from the model and not from the web/);
  assert.equal(judgeInBoxProof({ reply: "", toolNames: ["WebSearch"] }).ok, false);
  // The host's own sentence for a box with nothing set up, which is the exact failure this closes.
  const stillBroken = judgeInBoxProof({
    reply: "Could not run that search. No web search service is set up on this machine.",
    toolNames: ["WebSearch"],
  });
  assert.equal(stillBroken.ok, false);
  assert.match(stillBroken.why, /no web search service is set up/);
  assert.equal(judgeInBoxProof({ reply: "Node 24 is current.", toolNames: ["websearch"] }).ok, true);
});

// --------------------------------------------------------------------------- the whole command

test("with the proxy's doors empty, nothing is written and no box is even asked", async () => {
  const boxes = fleet({ "beta-33": {}, "beta-34": {} });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, passThrough: deadDoors(), tenants: ["beta-33", "beta-34"] });
  const answer = await api.set({ slugs: ["beta-33", "beta-34"] });
  assert.equal(answer.ok, false);
  assert.equal(answer.written, 0);
  assert.deepEqual(boxes.calls, [], "the refusal happens before any workspace is touched");
  assert.match(lines.join("\n"), /STOPPED before touching any workspace/);
  assert.match(lines.join("\n"), /PROXY_TINYFISH_KEY_1/);
});

test("a dry run past a dead door still shows the plan, and still says it would stop", async () => {
  // THE STATE THE FLEET IS ACTUALLY IN. Measured on the R750 2026-09-15: both doors serve with an
  // empty credential. A dry run that stopped at the refusal could say nothing at all about a fleet
  // on the one night somebody wanted to look at it, so it carries on, writes nothing, and says in
  // its first line that a real run would stop.
  const boxes = fleet({ "beta-33": {}, demo: { section: { TINYFISH_API_KEY: OPERATOR_KEY } } });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, passThrough: deadDoors(), tenants: ["beta-33", "demo"] });
  const answer = await api.set({ slugs: ["beta-33", "demo"], dryRun: true });
  assert.equal(answer.ok, false, "it is still not a run that went through");
  assert.equal(answer.written, 0);
  assert.deepEqual(answer.results.map((row) => row.action), ["would-write", "would-write"]);
  assert.equal(boxes.calls.filter((call) => call.command === "setWebSearchRoute").length, 0);
  assert.equal(boxes.sectionOf("beta-33"), null);
  const said = lines.join("\n");
  assert.match(said, /a real run would STOP here before touching any workspace/);
  assert.match(said, /PROXY_TINYFISH_KEY_1/);
  assert.match(said, /nothing here writes anything/);
  // And the real run in the same state still refuses before asking any box a thing.
  const strict = fleet({ "beta-33": {} });
  const real = provisioner({ boxCall: strict.boxCall, passThrough: deadDoors(), tenants: ["beta-33"] });
  await real.api.set({ slugs: ["beta-33"] });
  assert.deepEqual(strict.calls, [], "a real run touches nothing");
});

test("a dry run says what it would write into each box and writes nothing", async () => {
  const boxes = fleet({ "beta-33": {}, demo: { section: { TINYFISH_API_KEY: OPERATOR_KEY } } });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["beta-33", "demo"] });
  const answer = await api.set({ slugs: ["beta-33", "demo"], dryRun: true });
  assert.equal(answer.written, 0);
  assert.deepEqual(answer.results.map((row) => row.action), ["would-write", "would-write"]);
  assert.equal(boxes.calls.filter((call) => call.command === "setWebSearchRoute").length, 0);
  assert.equal(boxes.sectionOf("beta-33"), null, "the box that had nothing still has nothing");
  assert.equal(boxes.sectionOf("demo").TINYFISH_API_KEY, OPERATOR_KEY, "and the one that had a key is untouched");
  const said = lines.join("\n");
  assert.match(said, /dry run: nothing was written into any box/);
  assert.match(said, /holds no key at all today/);
  assert.match(said, /holds a different key today/);
});

test("a real run writes the three fields, one workspace at a time, and proves the door", async () => {
  const boxes = fleet({ "beta-33": {}, "beta-34": {} });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["beta-33", "beta-34"] });
  const answer = await api.set({ slugs: ["beta-33", "beta-34"] });
  assert.equal(answer.written, 2);
  for (const slug of ["beta-33", "beta-34"]) {
    const section = boxes.sectionOf(slug);
    assert.equal(section.TINYFISH_API_KEY, keyFor(slug), "each box holds its OWN key, never a shared one");
    assert.equal(section.TINYFISH_FETCH_ENDPOINT, ENDPOINTS.fetchEndpoint);
    assert.equal(section.TINYFISH_SEARCH_ENDPOINT, ENDPOINTS.searchEndpoint);
  }
  // ONE AT A TIME. Every call for the first workspace happens before the first call for the second.
  const order = boxes.calls.map((call) => call.slug);
  assert.equal(order.lastIndexOf("beta-33") < order.indexOf("beta-34"), true, order.join(", "));
  assert.match(lines.join("\n"), /proved: this workspace's own key opened the search address and got 1 result/);
});

test("running it again changes nothing and makes no write call", async () => {
  const boxes = fleet({ demo: {} });
  const first = provisioner({ boxCall: boxes.boxCall, tenants: ["demo"] });
  await first.api.set({ slugs: ["demo"] });
  const before = boxes.calls.length;
  const second = provisioner({ boxCall: boxes.boxCall, tenants: ["demo"] });
  const answer = await second.api.set({ slugs: ["demo"] });
  assert.equal(answer.written, 0);
  assert.deepEqual(answer.results.map((row) => row.action), ["already"]);
  const writesAfter = boxes.calls.slice(before).filter((call) => call.command === "setWebSearchRoute");
  assert.deepEqual(writesAfter, [], "idempotent means it does not write, not that writing twice is harmless");
  assert.match(second.lines.join("\n"), /already holds its own key against both proxy addresses/);
});

test("a box that will not answer stops that workspace and not the sweep", async () => {
  const boxes = fleet({ "beta-35": { down: true }, "beta-36": {} });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["beta-35", "beta-36"] });
  const answer = await api.set({ slugs: ["beta-35", "beta-36"] });
  assert.equal(answer.written, 1);
  assert.deepEqual(answer.results.map((row) => row.action), ["stop", "written"]);
  assert.equal(boxes.sectionOf("beta-36").TINYFISH_API_KEY, keyFor("beta-36"));
  assert.match(lines.join("\n"), /beta-35's box could not be asked/);
});

test("a door that answers 200 with nothing is reported as not proved, and the write still stands", async () => {
  const boxes = fleet({ demo: {} });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["demo"], fetchImpl: searchFetch([]) });
  const answer = await api.set({ slugs: ["demo"] });
  assert.equal(answer.written, 1);
  assert.equal(answer.results[0].door.ok, false);
  // The write is not rolled back, and the line says so plainly rather than reporting a success.
  assert.match(lines.join("\n"), /NOT proved:/);
  assert.equal(boxes.sectionOf("demo").TINYFISH_API_KEY, keyFor("demo"));
});

test("--prove asks the workspace's own bot, and judges the turn on the tools it called", async () => {
  // The one proof the door proof cannot give: the box's OWN WebSearch answering. It costs a visible
  // message in a customer's conversation and a model turn against their allowance, which is why it
  // is opt-in, and it is judged on the outline rather than on how the reply reads.
  //
  // A FRESH BOX PER CASE. The second run against a box the first run already wrote plans "already"
  // and never reaches the proof, which is the command behaving correctly and the test measuring
  // nothing, so each case gets its own directory.
  const turns = [];
  const answering = ({ reply, tools, alwaysRunning = false }) => {
    const boxes = fleet({ demo: {} });
    const mine = [];
    return {
      boxes,
      turns: mine,
      call: async (slug, command, args = {}) => {
        if (command === "sendPrompt") { mine.push(args); turns.push(args); return { ok: true, body: {} }; }
        if (command === "listAgents") {
          return { ok: true, body: [{ id: "agent-1", name: "Titan", isRunning: alwaysRunning && mine.length > 0 }] };
        }
        if (command === "getAgentTranscript") return { ok: true, body: [{ kind: "send-message", message: { content: reply } }] };
        if (command === "getConversationOutline") return { ok: true, body: tools.map((name) => ({ kind: "tool-call", name })) };
        return boxes.boxCall(slug, command, args);
      },
    };
  };

  const good = answering({ reply: "Node 24.11 is current.", tools: ["WebSearch", "SendMessage"] });
  const run = provisioner({ boxCall: good.call, tenants: ["demo"] });
  const passed = await run.api.set({ slugs: ["demo"], prove: true, question: "What is the current Node version?" });
  assert.equal(passed.results[0].action, "written");
  assert.equal(passed.results[0].inBox.ok, true);
  assert.deepEqual(good.turns.map((turn) => turn.prompt), ["What is the current Node version?"]);
  assert.equal(good.turns[0].agentId, "agent-1", "the bot called Titan, not whichever one came back first");
  assert.match(run.lines.join("\n"), /Titan answered through its own web tool/);
  assert.match(run.lines.join("\n"), /puts a message in their conversation/, "the cost is said before it is paid");

  // The same reply with no web tool behind it. A model answers a lookup question out of its own
  // memory and the sentence reads identically, so the outline is what decides.
  const memory = answering({ reply: "Node 24.11 is current.", tools: ["SendMessage"] });
  const fromMemory = await provisioner({ boxCall: memory.call, tenants: ["demo"] }).api.set({ slugs: ["demo"], prove: true });
  assert.equal(fromMemory.results[0].inBox.ok, false);
  assert.match(fromMemory.results[0].inBox.why, /came from the model and not from the web/);

  // A turn that never stops is a failure with a number on it, rather than a command that hangs.
  const wedged = answering({ reply: "", tools: [], alwaysRunning: true });
  let clock = 0;
  const stuck = await createWebSearchProvisioner({
    tenants: [{ slug: "demo" }],
    boxCall: wedged.call,
    proxy: { listPassThrough: async () => liveDoors() },
    keyOf: () => keyFor("demo"),
    proxyUrl: PROXY_URL,
    out: () => {},
    fetchImpl: searchFetch([{ title: "x", url: "https://x" }]),
    sleep: async () => {},
    now: () => (clock += 60_000),
    turnTimeoutMs: 120_000,
  }).set({ slugs: ["demo"], prove: true });
  assert.equal(stuck.results[0].inBox.ok, false);
  assert.match(stuck.results[0].inBox.why, /still working after 120 s/);
  // And the write it made still stands: a proof that could not be taken is not a write to undo.
  assert.equal(wedged.boxes.sectionOf("demo").TINYFISH_API_KEY, keyFor("demo"));
});

test("list measures the fleet, writes nothing, and prints no key", async () => {
  const boxes = fleet({
    demo: { section: { TINYFISH_API_KEY: OPERATOR_KEY } },
    "beta-33": {},
    titanium: { connectors: ["tinyfish"] },
  });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["demo", "beta-33", "titanium"] });
  const rows = await api.list();
  assert.deepEqual(rows.map((row) => row.route), ["api", "none", "connector"]);
  assert.deepEqual(rows.map((row) => row.answers), [true, false, true]);
  assert.equal(boxes.calls.every((call) => call.command === "getWebSearchRoute"), true, "a measurement never writes");
  const said = lines.join("\n");
  assert.match(said, /2 of 3 workspace\(s\) can answer a question about the web today\./);
  assert.ok(!said.includes(OPERATOR_KEY), "no key value on the terminal");
  assert.ok(!said.includes(keyFor("demo")));
  assert.equal(said.includes(sha12(OPERATOR_KEY)), true, "the hash prefix is what identifies it instead");
});

test("nothing this command prints ever carries a key, on any path through it", async () => {
  const boxes = fleet({ demo: { section: { TINYFISH_API_KEY: OPERATOR_KEY } }, "beta-33": {} });
  const { api, lines } = provisioner({ boxCall: boxes.boxCall, tenants: ["demo", "beta-33"] });
  await api.list();
  await api.set({ slugs: ["demo", "beta-33"], dryRun: true });
  await api.set({ slugs: ["demo", "beta-33"] });
  const said = lines.join("\n");
  for (const secret of [OPERATOR_KEY, keyFor("demo"), keyFor("beta-33")]) {
    assert.ok(!said.includes(secret), `a key reached the terminal: ${secret.slice(0, 6)}...`);
  }
  assert.ok(!/[—–]/.test(said), "and no em dash in anything a person reads");
  // The hashes ARE there, which is the point: an operator can prove which credential landed.
  assert.ok(said.includes(sha12(keyFor("demo"))));
  assert.equal(createHash("sha256").update(keyFor("demo")).digest("hex").slice(0, 12), sha12(keyFor("demo")));
});
