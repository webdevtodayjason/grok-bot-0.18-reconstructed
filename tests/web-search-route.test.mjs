// BASELINE-1, the host's half of piece 1: the box's web search route, read and written.
//
// WHAT WAS MEASURED, and why a door exists at all. On the R750 2026-09-15, seven of ten tenant boxes
// had no connector-env-secrets.json, so their customers were told "No web search service is set up
// on this machine" every time they asked about the world, and the only way to change that was a
// person with a shell inside the container. tinyfish-route.ts has always READ that file; nothing
// could write it.
//
// These cases drive the REAL modules against a real temporary sand root: the real describe, the real
// check, the real 0600 writer out of connector-secrets.ts. The two things they pin hardest are the
// two that would be silent: a read that leaks a value, and a half-applied write.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".web-search-route-test-"));
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
const route = await bundle("source/host/extensions/inference/web-search-route.ts", "web-search-route.cjs");
const secrets = await bundle("source/host/extensions/mcp/connector-secrets.ts", "connector-secrets.cjs");

const freshRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "web-search-route-"));
  roots.push(root);
  return root;
};
const sectionOf = (root) => secrets.readConnectorEnvSecrets(root)[route.WEB_SEARCH_ROUTE_SERVER] ?? null;

/** An invented key of the shape a virtual key has, so no real credential is anywhere near this file. */
const TENANT_KEY = "sk-not-a-real-key-000000001";
const PROXY_FETCH = "http://titanbot-proxy:4000/tinyfish/fetch";
const PROXY_SEARCH = "http://titanbot-proxy:4000/tinyfish/search";

/** The whole of what setWebSearchRoute does, built exactly as host-gateway-api.ts builds it. */
function setRoute(root, args) {
  const checked = route.checkWebSearchRouteWrite(args);
  if (!checked.ok) throw new Error(checked.why);
  const { apiKey, fetchEndpoint, searchEndpoint } = checked.write;
  const values = [
    [route.WEB_SEARCH_ROUTE_FIELDS[0], apiKey],
    [route.WEB_SEARCH_ROUTE_FIELDS[1], fetchEndpoint],
    [route.WEB_SEARCH_ROUTE_FIELDS[2], searchEndpoint],
  ];
  const before = route.describeWebSearchRoute(sectionOf(root));
  for (const [field, value] of values) {
    assert.equal(secrets.writeConnectorEnvSecret(root, route.WEB_SEARCH_ROUTE_SERVER, field, value), true);
  }
  const after = route.describeWebSearchRoute(sectionOf(root));
  return {
    ...route.webSearchRouteEvidence(checked.write),
    changed: before.keySha256 !== after.keySha256
      || before.fetchEndpoint !== after.fetchEndpoint
      || before.searchEndpoint !== after.searchEndpoint,
    route: after,
  };
}

// ------------------------------------------------------------------------------------ the read

test("a box with nothing set up reads as none, and says so rather than half saying it", () => {
  const view = route.describeWebSearchRoute(null, []);
  assert.equal(view.route, "none");
  assert.equal(view.answers, false, "the one word the console has for whether a question can be answered");
  assert.equal(view.keyLength, 0);
  assert.equal(view.keySha256, "");
  // The endpoints still read as the vendor's own defaults, because that is what the route resolver
  // would use the moment a key arrived. A view answering "" here would say a box was pointed
  // nowhere, which is not the same thing and is not true.
  assert.match(view.fetchEndpoint, /^https:\/\/api\.fetch\.tinyfish\.ai/);
  assert.match(view.searchEndpoint, /^https:\/\/api\.search\.tinyfish\.ai/);
  assert.equal(view.metered, false);
});

test("a stored key with no endpoints is the api route on the vendor's own hosts, and is not metered", () => {
  // The PROXY-7 state, measured in three boxes on the R750 on 2026-09-15: the operator's own
  // 44-character TinyFish key, no endpoints, so every one of those boxes was calling the vendor
  // directly on one shared credential.
  const view = route.describeWebSearchRoute({ TINYFISH_API_KEY: "x".repeat(44) }, []);
  assert.equal(view.route, "api");
  assert.equal(view.answers, true);
  assert.equal(view.keyLength, 44);
  assert.equal(view.keySha256.length, 12, "twelve hex characters, the same evidence shape proxy migrate uses");
  assert.equal(view.metered, false, "the vendor's own host is not this product's proxy");
});

test("the connector outranks a stored key, the same order resolveWebFallback keeps", () => {
  // Getting this backwards would report a box as unserved while its customer's searches answered
  // perfectly well through the connector it runs itself.
  const view = route.describeWebSearchRoute({ TINYFISH_API_KEY: "k" }, ["tinyfish", "github"]);
  assert.equal(view.route, "connector");
  assert.equal(view.answers, true);
  const without = route.describeWebSearchRoute({ TINYFISH_API_KEY: "k" }, ["github"]);
  assert.equal(without.route, "api");
});

test("no read returns a stored value, whatever is in the section", () => {
  const view = route.describeWebSearchRoute({ TINYFISH_API_KEY: TENANT_KEY, TINYFISH_SEARCH_ENDPOINT: PROXY_SEARCH }, []);
  const rendered = JSON.stringify(view);
  assert.ok(!rendered.includes(TENANT_KEY), "the key is not in the answer");
  assert.ok(!rendered.includes(TENANT_KEY.slice(4)), "and no substring of it either");
  assert.equal(view.keyLength, TENANT_KEY.length);
});

test("pointing at the proxy reads as metered, and pointing at one of each does not", () => {
  const both = route.describeWebSearchRoute({ TINYFISH_API_KEY: "k", TINYFISH_FETCH_ENDPOINT: PROXY_FETCH, TINYFISH_SEARCH_ENDPOINT: PROXY_SEARCH }, []);
  assert.equal(both.metered, true);
  // A box with the search moved and the fetch left behind is a box whose searches are metered and
  // whose fetches are still on the operator's own subscription. It is not "metered", and calling it
  // that is how a spend panel comes to show a customer nothing.
  const half = route.describeWebSearchRoute({ TINYFISH_API_KEY: "k", TINYFISH_SEARCH_ENDPOINT: PROXY_SEARCH }, []);
  assert.equal(half.metered, false);
});

// ----------------------------------------------------------------------------------- the write

test("a write moves the credential and both addresses together, and the file is 0600", () => {
  const root = freshRoot();
  const answer = setRoute(root, { apiKey: TENANT_KEY, fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH });
  assert.equal(answer.changed, true);
  assert.equal(answer.keyLength, TENANT_KEY.length);
  assert.equal(answer.route.route, "api");
  assert.equal(answer.route.metered, true);
  const section = sectionOf(root);
  assert.deepEqual(Object.keys(section).sort(), [...route.WEB_SEARCH_ROUTE_FIELDS].sort());
  assert.equal(section.TINYFISH_API_KEY, TENANT_KEY);
  assert.equal(section.TINYFISH_SEARCH_ENDPOINT, PROXY_SEARCH);
  // SECRET-3. This file holds every connector's credential, and it was 0644 on Richard's box once.
  const file = path.join(root, "connector-env-secrets.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes(TENANT_KEY), "the value really is stored; this is the only place it may appear");
});

test("a second identical write is not a change, so a sweep can say what it touched", () => {
  const root = freshRoot();
  setRoute(root, { apiKey: TENANT_KEY, fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH });
  const again = setRoute(root, { apiKey: TENANT_KEY, fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH });
  assert.equal(again.changed, false, "ten workspaces written every night is not ten workspaces changed");
  assert.equal(again.route.keySha256, route.describeWebSearchRoute(sectionOf(root)).keySha256);
});

test("a write replaces a key that was somebody else's and leaves the rest of the file alone", () => {
  const root = freshRoot();
  // A box as the R750 really had one: the operator's shared key, plus an unrelated connector's.
  secrets.writeConnectorEnvSecret(root, "tinyfish", "TINYFISH_API_KEY", "o".repeat(44));
  secrets.writeConnectorEnvSecret(root, "github", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_invented");
  const before = route.describeWebSearchRoute(sectionOf(root));
  const answer = setRoute(root, { apiKey: TENANT_KEY, fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH });
  assert.equal(answer.changed, true);
  assert.notEqual(answer.route.keySha256, before.keySha256);
  assert.equal(secrets.readConnectorEnvSecrets(root).github.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_invented",
    "another connector's credential is not this command's business");
});

test("every refusal is a sentence, and a refused write stores nothing at all", () => {
  const root = freshRoot();
  const refusals = [
    [{ fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH }, /non-empty `apiKey`/],
    [{ apiKey: "  ", fetchEndpoint: PROXY_FETCH, searchEndpoint: PROXY_SEARCH }, /non-empty `apiKey`/],
    [{ apiKey: TENANT_KEY, fetchEndpoint: "not a url", searchEndpoint: PROXY_SEARCH }, /`fetchEndpoint` to be an http or https address/],
    [{ apiKey: TENANT_KEY, fetchEndpoint: PROXY_FETCH, searchEndpoint: "" }, /`searchEndpoint` to be an http or https address/],
    // A scheme that is not http is either a mistake or a place a credential should never be sent.
    [{ apiKey: TENANT_KEY, fetchEndpoint: "file:///etc/passwd", searchEndpoint: PROXY_SEARCH }, /`fetchEndpoint`/],
    [{ apiKey: TENANT_KEY, fetchEndpoint: PROXY_SEARCH, searchEndpoint: PROXY_SEARCH }, /the same, so one of them is wrong/],
    [null, /non-empty `apiKey`/],
  ];
  for (const [args, expected] of refusals) {
    const checked = route.checkWebSearchRouteWrite(args);
    assert.equal(checked.ok, false, `${JSON.stringify(args)} is refused`);
    assert.match(checked.why, expected);
    assert.ok(!/[—–]/.test(checked.why), "no em dash in a sentence a person reads");
  }
  assert.equal(sectionOf(root), null, "a refused write left the box exactly as it was");
});

test("the fields the host writes are the fields the route resolver reads", () => {
  // Two modules, one truth. tinyfish-route.ts names the fields the fallback resolves from, and this
  // module names the fields the control plane writes. They come from the same constants on purpose,
  // and this case fails if either ever hardcodes its own spelling.
  const source = readFileSync(path.join(repoRoot, "source/host/extensions/inference/tinyfish-route.ts"), "utf8");
  for (const field of route.WEB_SEARCH_ROUTE_FIELDS) {
    assert.ok(source.includes(`"${field}"`), `${field} is the same name tinyfish-route.ts resolves from`);
  }
  assert.equal(route.WEB_SEARCH_ROUTE_SERVER, "tinyfish");
  assert.ok(source.includes('TINYFISH_CONNECTOR_NAME = "tinyfish"'));
});
