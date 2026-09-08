// MARKET-5: one credential home per provider.
//
// The complaint was literal. The TinyFish plugin page drew TWO masked forms for one provider, each
// with a note warning that the value typed into the other one did not reach it. They really are two
// processes -- an MCP server the box spawns, and a CLI the agent runs in its shell -- but they are
// two CONSUMERS of one key, and the person minting it at the vendor does it once.
//
// So the plugin declares where its credential goes, and one write fans out. These cases pin the
// resolution: what a declaration produces, what an undeclared plugin falls back to, and the two
// shapes that could quietly resolve to nothing (a header consumer, and a plugin with no connector).
//
// PROXY-7's shape rides along, because it is the same question asked the other way: when the plan
// carries the service, there is no credential home at all and the page must not draw a box.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".plugin-fanout-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const plugins = await bundle("source/host/extensions/mcp/marketplace-plugins.ts", "marketplace-plugins.cjs");
const catalog = await bundle("source/shared/marketplace/catalog.ts", "catalog.cjs");

const connectorPlugin = (extra = {}) => ({
  id: "acme", name: "Acme", kind: "connector", connectorName: "acme",
  credentialHints: { ACME_TOKEN: "Mint one at acme.example/tokens with read scope." },
  ...extra,
});

test("a declaration with two consumers fans one value out to both", () => {
  const plugin = connectorPlugin({
    credentials: [{
      field: "ACME_TOKEN",
      consumers: [
        { kind: "connector", env: "ACME_TOKEN" },
        { kind: "shell", env: "ACME_CLI_TOKEN" },
      ],
    }],
  });
  assert.deepEqual(plugins.pluginCredentialConsumers(plugin, "ACME_TOKEN"), [
    { kind: "connector", connector: "acme", env: "ACME_TOKEN" },
    { kind: "shell", env: "ACME_CLI_TOKEN" },
  ]);
});

// The reason the declaration carries an `env` per consumer rather than reusing the field name: a
// provider's CLI and its MCP server routinely read DIFFERENT variables from the same key, and the
// two-row shape could never express that without asking the person to type it twice.
test("each consumer keeps its own variable name, which is why one row could not do this", () => {
  const github = connectorPlugin({
    id: "github", name: "GitHub", connectorName: "github",
    credentials: [{
      field: "GITHUB_PERSONAL_ACCESS_TOKEN",
      consumers: [
        { kind: "connector", env: "GITHUB_PERSONAL_ACCESS_TOKEN" },
        { kind: "shell", env: "GITHUB_TOKEN" },
      ],
    }],
  });
  const consumers = plugins.pluginCredentialConsumers(github, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.deepEqual(consumers.map((consumer) => consumer.env), [
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_TOKEN",
  ]);
});

test("a header consumer resolves to the connector, because the placeholder already names the field", () => {
  // A remote entry carries "Authorization: Bearer ${ACME_TOKEN}" and the host substitutes from that
  // connector's own section of the store at push time. A separate destination would be a second
  // place to look for the same value.
  const plugin = connectorPlugin({
    credentials: [{ field: "ACME_TOKEN", consumers: [{ kind: "header", name: "Authorization" }] }],
  });
  assert.deepEqual(plugins.pluginCredentialConsumers(plugin, "ACME_TOKEN"), [
    { kind: "connector", connector: "acme", env: "ACME_TOKEN" },
  ]);
});

test("a plugin that declares nothing falls back to the shape it already has", () => {
  assert.deepEqual(plugins.pluginCredentialConsumers(connectorPlugin(), "ACME_TOKEN"), [
    { kind: "connector", connector: "acme", env: "ACME_TOKEN" },
  ]);
  const shellTool = { id: "coderabbit", name: "CodeRabbit", kind: "shell-tool", credentialHints: {} };
  assert.deepEqual(plugins.pluginCredentialConsumers(shellTool, "CODERABBIT_API_KEY"), [
    { kind: "shell", env: "CODERABBIT_API_KEY" },
  ]);
});

// The failure this guards: a connector consumer on a plugin with no connectorName resolved to
// `connector: undefined`, and the write went to a section of the store named "undefined" -- stored,
// reported stored, and read by nothing ever again.
test("a consumer with nowhere to go is dropped rather than written to a nonexistent connector", () => {
  const editorCard = {
    id: "custom", name: "Add your own", kind: "connector", credentialHints: {},
    credentials: [{ field: "ACME_TOKEN", consumers: [{ kind: "connector", env: "ACME_TOKEN" }] }],
  };
  assert.deepEqual(plugins.pluginCredentialConsumers(editorCard, "ACME_TOKEN"), []);
});

test("a field the plugin never declared still resolves, so an operator-named variable works", () => {
  const plugin = connectorPlugin({
    credentials: [{ field: "ACME_TOKEN", consumers: [{ kind: "shell", env: "ACME_TOKEN" }] }],
  });
  // Not ACME_TOKEN: a second field, undeclared. It takes the plugin's default home.
  assert.deepEqual(plugins.pluginCredentialConsumers(plugin, "ACME_REGION_KEY"), [
    { kind: "connector", connector: "acme", env: "ACME_REGION_KEY" },
  ]);
});

// ------------------------------------------------------------------ PROXY-7's shape, not its leg
test("with no proxy configured the catalog comes back byte for byte, which is every box today", () => {
  const answer = plugins.catalogForBox(catalog.MARKETPLACE_CATALOG, () => null);
  assert.equal(answer, catalog.MARKETPLACE_CATALOG, "an untouched catalog must be the SAME object");
  for (const plugin of answer.plugins) {
    assert.equal(plugin.includedWithPlan, undefined, `${plugin.id} claims a plan nobody configured`);
  }
});

test("a plugin the plan carries says so and draws no key box", () => {
  const carried = catalog.MARKETPLACE_CATALOG.plugins.filter((plugin) => plugin.proxyMcpServer != null);
  assert.ok(carried.length > 0, "no plugin in the catalog declares a proxy mount, so this asserts nothing");
  const answer = plugins.catalogForBox(
    catalog.MARKETPLACE_CATALOG,
    (server) => (server === carried[0].proxyMcpServer ? "http://titanbot-proxy:4000/mcp/" : null),
  );
  const row = answer.plugins.find((plugin) => plugin.id === carried[0].id);
  assert.equal(row.includedWithPlan, true);
  assert.deepEqual(row.credentialHints, {}, "a plan-carried plugin must offer nothing to type");
  // And only that row: a proxy for one service does not silently include the rest.
  const others = answer.plugins.filter((plugin) => plugin.id !== carried[0].id);
  assert.ok(others.every((plugin) => plugin.includedWithPlan === undefined));
});

test("a plan-carried plugin offers the operator no field to fill", () => {
  const reader = { rootDir: () => stage };
  const plain = connectorPlugin();
  const carried = connectorPlugin({ includedWithPlan: true, credentialHints: {} });
  assert.ok(plugins.marketplacePluginFields(reader, plain).length > 0);
  assert.deepEqual(plugins.marketplacePluginFields(reader, carried), []);
});

test("plan inclusion needs BOTH the plugin's mount and a configured url", () => {
  const withMount = connectorPlugin({ proxyMcpServer: "acme" });
  assert.equal(plugins.pluginIncludedWithPlan(withMount, () => "http://titanbot-proxy:4000/mcp/"), true);
  assert.equal(plugins.pluginIncludedWithPlan(withMount, () => ""), false);
  assert.equal(plugins.pluginIncludedWithPlan(withMount, () => null), false);
  assert.equal(plugins.pluginIncludedWithPlan(connectorPlugin(), () => "http://titanbot-proxy:4000/mcp/"), false);
});
