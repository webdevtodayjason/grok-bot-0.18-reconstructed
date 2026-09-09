// MARKET-1 / PLUGINTOOLS-1. The Marketplace catalog, and the four plugin tools now resolving
// against it instead of Cursor's marketplace.
//
// Four claims, and they are the ones that can actually go wrong:
//
//  1. The catalog is internally true -- every plugin's category is one of the declared categories,
//     every bot integration names a real plugin, every credential field has a hint.
//  2. Nothing in it is a secret. Every env value is the empty string (which is exactly how the host
//     recognises a credential field, CONNECT-4), and no string in the whole catalog is shaped like
//     a key. A catalog is a file in the repo; a key in it would be a key in git.
//  3. It has not drifted from the console's preset row. The same connector entries exist in
//     ui/machine-room/gateway-adapter.js, which tests/connector-preset-catalog.test.mjs holds
//     against docs/connectors/. This file closes the third side of that triangle, so editing any
//     one of the three alone fails.
//  4. The tools do what the contract says: SearchPlugins filters, InstallPlugin writes the entry
//     through the host's own connectors.json door and answers with the fields still empty, and
//     UninstallPlugin takes it out again -- leaving the file byte-identical to what it was. And the
//     two facts a shell tool has stay apart: whether its PROGRAM is on the box (the shell's own
//     `command -v`) is the install state, and whether its KEY is stored is the field's `isStored`.
//
// The install and uninstall run against a temp sand-data root. Nothing here touches the box, the
// network, or a real credential; the only "value" written anywhere is the empty string.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".marketplace-test-"));
const root = mkdtempSync(path.join(tmpdir(), "marketplace-"));
after(() => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const catalog = await bundle("source/shared/marketplace/catalog.ts", "marketplace-catalog.cjs");
const host = await bundle("source/host/extensions/mcp/marketplace-plugins.ts", "marketplace-plugins.cjs");
const tools = await bundle("source/host/runner/tools/sand-mcp-management-tools.ts", "mcp-management-tools.cjs");

const CONNECTORS = path.join(root, "connectors.json");
const SECRETS = path.join(root, "connector-env-secrets.json");
// The probe is stubbed so the assertion is about the RULE, not about whether the machine running
// the suite happens to have `cr` on its PATH. `probeShellToolBinary` itself is exercised below
// against a real shell, with a name nothing could have installed.
let shellBinaries = new Set();
const reader = { rootDir: () => root, probeShellTool: async (entry) => shellBinaries.has(entry.binary) };

// ---------------------------------------------------------------- 1. the catalog is internally true

test("the catalog validates: categories, integrations and hints all resolve", () => {
  const problems = catalog.validateMarketplaceCatalog();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every plugin carries a category from the declared list", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    assert.ok(
      catalog.MARKETPLACE_PLUGIN_CATEGORIES.includes(plugin.category),
      `plugin ${plugin.id} has category "${plugin.category}"`,
    );
    assert.ok(plugin.tagline.length > 0 && !plugin.tagline.includes("\n"), `plugin ${plugin.id} tagline is not one line`);
    assert.ok(plugin.icon.letter.length > 0 && plugin.icon.color.startsWith("#"), `plugin ${plugin.id} icon`);
    // QOL-LOGOS relaxed this by exactly one field. The icon is a letter on a colour, and it may
    // also name a LOCAL logo file the relay serves out of ui/machine-room/ -- never a URL, and
    // nothing else: tests/marketplace-logos.test.mjs holds each of those paths against the repo.
    assert.ok(["color,letter", "color,file,letter"].includes(Object.keys(plugin.icon).sort().join(",")),
      `plugin ${plugin.id} icon carries ${Object.keys(plugin.icon).sort().join(",")}`);
    assert.equal(catalog.marketplaceLogoProblem(`plugin ${plugin.id}`, plugin.icon.file), null);
  }
  // The catalog MARKET-6 shipped, and every row it shipped is still here.
  //
  // A NAMED FLOOR RATHER THAN AN EXACT LIST, deliberately. This used to pin the id list exactly,
  // which meant the first row any later wave added turned this suite red -- and the deploy gate
  // with it -- for a reason nobody reading the failure could act on. What is worth pinning is that
  // nothing DISAPPEARS: a row going missing is a customer's connector vanishing at a release, and
  // that is what this catches. A row appearing is a wave doing its job.
  const shipped = new Set(catalog.MARKETPLACE_PLUGINS.map((plugin) => plugin.id));
  for (const id of [
    "github", "slack", "linear", "google", "tinyfish", "context7", "exa", "cloudflare-docs", "deepwiki",
    "notion", "airtable", "todoist", "playwright", "resend", "stripe", "browser-use", "localfiles",
    "coderabbit", "custom-mcp",
  ]) {
    assert.ok(shipped.has(id), `the catalog no longer carries "${id}", which it shipped with`);
  }
  assert.equal(shipped.size, catalog.MARKETPLACE_PLUGINS.length, "two rows share an id");
});

test("every bot names real plugins, a declared category and at least one skill", () => {
  const ids = new Set(catalog.MARKETPLACE_PLUGINS.map((plugin) => plugin.id));
  // A FLOOR, not a count. The six original templates have to still be there; a seventh row (the
  // Marketing team pack) is a feature, and a test that fails on one is a test that makes adding a
  // template feel like breaking something.
  const botIds = new Set(catalog.MARKETPLACE_BOTS.map((bot) => bot.id));
  for (const id of ["research-desk", "pr-review-desk", "ops-watcher", "issue-triage", "inbox-triage", "course-note-taker"]) {
    assert.ok(botIds.has(id), `the ${id} template is gone from the catalog`);
  }
  assert.equal(botIds.size, catalog.MARKETPLACE_BOTS.length, "two bot rows share an id");
  for (const bot of catalog.MARKETPLACE_BOTS) {
    assert.ok(catalog.MARKETPLACE_BOT_CATEGORIES.includes(bot.category), `bot ${bot.id} category "${bot.category}"`);
    // BOTS-1 scoped the next three to the rows WE WROTE rather than deleting them. A community row
    // is credited to the person who wrote it, may name no plugin we carry, and may arrive with no
    // skill at all -- and each of those is still a defect on a first-party template. What holds for
    // every row is in validateMarketplaceCatalog, and tests/community-bots.test.mjs is where the
    // community half is checked.
    if (bot.origin !== "community") {
      assert.equal(bot.creator, "Titanbot team");
      assert.ok(bot.integrations.length > 0, `bot ${bot.id} names no integration`);
      assert.ok(bot.skills.length > 0, `bot ${bot.id} has no skill`);
    }
    for (const integration of bot.integrations) assert.ok(ids.has(integration), `bot ${bot.id} names "${integration}"`);
    for (const skill of bot.skills) {
      // A skill's body is a SKILL.md: front matter first, so importAgentWorkflowText can read it.
      assert.ok(skill.body.startsWith("---\nname: "), `bot ${bot.id} skill ${skill.name} has no front matter`);
      // A first-party row's skill name IS its document name. A community row's is the human label
      // the page shows in bold, and the document is namespaced by the bot id, because 65 packs that
      // each ship a "Getting started" would otherwise fight over one document in the shared library.
      const documentName = bot.origin === "community"
        ? `${bot.skillPrefix}${skill.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
        : skill.name;
      assert.match(skill.body, new RegExp(`^---\\nname: ${documentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`), `bot ${bot.id} skill name mismatch`);
    }
    assert.ok(bot.instructions.length > 0, `bot ${bot.id} has no persona`);
  }
});

// ---------------------------------------------------------------- 2. nothing in it is a secret

// A remote row's entry is the daemon's own {type, url, headers} shape and has no env at all: it
// runs no process, and the fields it owes are named as ${FIELD} placeholders in its headers, which
// the no-credential test below reads. Only a program has an environment to check here.
test("no env value in any entry is non-empty except a declared configuration key", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    const entry = catalog.marketplaceConnectorEntry(plugin);
    if (entry == null || entry.command === undefined) continue;
    for (const [field, value] of Object.entries(entry.env ?? {})) {
      assert.ok(
        value === "" || catalog.MARKETPLACE_CONFIGURATION_ENV_KEYS.includes(field),
        `plugin ${plugin.id} gives env ${field} a non-empty value`,
      );
    }
  }
});

test("no string in the catalog is shaped like a credential", () => {
  // The prefixes the seeded services actually mint, each demanding a run of key-length characters
  // after it -- so a hint that says "a user token (xoxp-)" is fine and a real token is not. The
  // last two are the generic shapes: a long unbroken base64-ish run, and an obvious assignment.
  //
  // BOTS-1 REPLACED THE GENERIC RUN, because it read English as a secret. `[A-Za-z0-9+_-]{40,}`
  // fires on "account-book-account-brief-before-a-call" (a namespaced skill document name) and on
  // the path half of "github.com/modelcontextprotocol/servers/tree/main/src/filesystem", and a
  // test that cries wolf on sixty of those is a test somebody eventually deletes. What a secret
  // actually is, is a HIGH-ENTROPY run: forty characters that mix case AND carry a digit, or a
  // long lowercase hex string. A hyphenated English phrase is neither; every real token is one.
  const shapes = [
    /\b(?:xox[bpcdesar]|ghp|gho|ghu|ghs|ghr|github_pat|lin_api|sk|pk|AKIA|AIza|cr)[-_][A-Za-z0-9_-]{16,}/,
    /(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/,
    /\b[0-9a-f]{32,}\b/,
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
  ];
  const walk = (value, where) => {
    if (typeof value === "string") {
      for (const shape of shapes) {
        assert.ok(!shape.test(value), `${where} contains something shaped like a credential`);
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${where}[${index}]`));
    if (value != null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
    }
  };
  walk(catalog.MARKETPLACE_CATALOG, "catalog");
});

// ---------------------------------------------------------------- 3. it has not drifted

// The same stub-window harness tests/connector-preset-catalog.test.mjs uses: run the adapter's
// IIFE and read the preset array off the window, exactly as the browser and the gate do.
async function loadConsolePresets() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    open: () => {},
  };
  const fetchStub = async () => ({ ok: true, text: async () => "{}", json: async () => ({}) });
  return new Function("window", "fetch", `${body}\nreturn window.__connectorPresets;`)(window, fetchStub);
}

// MARKET-6 moved one side of this triangle. A catalog row now declares a SPEC -- an endpoint, or a
// program -- and `connectorEntryFromSpec` is the single function that turns one into a
// connectors.json entry, so the bridge's own arguments (which mcp-remote, pinned to which version,
// where it keeps its state) belong to that function and not to any row. The console's preset array
// is still hand-written at this commit and therefore still carries the pre-MARKET-6 argument list.
//
// So what is pinned here is what CAN actually drift and matter: which connector name a preset
// takes, which credential fields it asks for, that each of them carries a sentence, and -- for a
// remote row -- the address and the header names. The bridge arguments are deliberately not
// compared, because the catalog is now their only author. When the adapter derives its presets
// from the catalog, this test tightens back to equality on the whole entry and this comment goes.
test("the console's preset row still names the catalog's connector, fields and endpoint", async () => {
  const presets = await loadConsolePresets();
  for (const preset of presets) {
    const plugin = catalog.findMarketplacePlugin(preset.id);
    assert.ok(plugin != null, `the console offers preset "${preset.id}" and the catalog has no such plugin`);
    assert.equal(plugin.connectorName, preset.name, `${preset.id}: connector name`);

    const spec = catalog.marketplaceConnectorSpec(plugin);
    assert.ok(spec != null, `${preset.id}: the catalog row installs no connector`);
    assert.deepEqual(
      Object.keys(spec.env).sort(),
      Object.keys(preset.entry.env ?? {}).sort(),
      `${preset.id}: the environment variable names the operator has to fill`,
    );
    // The hint TEXT is the catalog's to write -- MARKET-5 rewrote TinyFish's so that one sentence
    // covers both places the key lands, which is the whole point of folding the CLI row in. What
    // both sides must agree on is that every field the operator has to fill carries a sentence,
    // because a masked box with nothing under it is the bug CONNECT-4 was about.
    const hints = catalog.marketplaceCredentialHints(plugin);
    assert.deepEqual(Object.keys(hints).sort(), Object.keys(preset.hints ?? {}).sort(), `${preset.id}: which fields carry a hint`);
    for (const field of catalog.marketplaceCredentialFields(plugin)) {
      assert.ok(hints[field]?.length > 0, `${preset.id}: ${field} has no hint in the catalog`);
      assert.ok((preset.hints ?? {})[field]?.length > 0, `${preset.id}: ${field} has no hint on the console side`);
    }

    if (spec.transport === "stdio") {
      // A program is its own entry: nothing is derived, so this stays an exact comparison.
      assert.deepEqual(catalog.marketplaceConnectorEntry(plugin), preset.entry, `${preset.id}: the connectors.json entry`);
      continue;
    }
    // A remote row: the address and the header names are the contract, and the preset reaches the
    // same endpoint through whatever bridge arguments it was written with.
    const argsText = preset.entry.args.join(" ");
    assert.ok(argsText.includes(spec.url), `${preset.id}: the console's preset does not point at ${spec.url}`);
    for (const header of Object.keys(spec.headers)) {
      assert.ok(argsText.toLowerCase().includes(header.toLowerCase()), `${preset.id}: the console's preset does not send ${header}`);
    }
  }
});

// ---------------------------------------------------------------- 4. the tools

const summariesFor = () => host.listMarketplacePluginSummaries(reader);

test("SearchPlugins filters on name, tagline and category", async () => {
  const all = await summariesFor();
  assert.equal(all.length, catalog.MARKETPLACE_PLUGINS.length);
  // By name.
  assert.deepEqual(tools.rankPluginsLexically(all, "linear").map((row) => row.pluginId), ["linear"]);
  // By tagline: nothing is called "pull request" but the PR-shaped plugin says so in its line.
  assert.deepEqual(tools.rankPluginsLexically(all, "pull requests").map((row) => row.pluginId), ["github"]);
  // By category.
  assert.deepEqual(
    tools.rankPluginsLexically(all, "code review").map((row) => row.pluginId).sort(),
    ["coderabbit"],
  );
  // A query nothing matches filters everything out, rather than falling back to the whole list.
  assert.deepEqual(tools.rankPluginsLexically(all, "kubernetes").map((row) => row.pluginId), []);
  // An empty query is the whole catalog, alphabetically by display name.
  assert.equal(tools.rankPluginsLexically(all, "").length, all.length);
  // And the catalog's own filter, which the console's search field uses, agrees. It is a substring
  // match over name, tagline and category, so "search" legitimately finds Slack's tagline too.
  assert.deepEqual(catalog.searchMarketplacePlugins("web search").map((row) => row.id), ["tinyfish"]);
  // A floor again, for the same reason: "search" is a substring match over name, tagline and
  // category, so a later row whose own words contain it joins this list legitimately. What must
  // not happen is one of these dropping OUT.
  const found = catalog.searchMarketplacePlugins("search").map((row) => row.id);
  for (const id of ["slack", "tinyfish", "exa", "cloudflare-docs", "playwright", "browser-use"]) {
    assert.ok(found.includes(id), `"search" no longer finds "${id}"`);
  }
  // And the point of `keywords`: an owner types what they want, not what it is called. None of
  // these words appears in the tagline, the name or the category of the row that answers.
  assert.deepEqual(catalog.searchMarketplacePlugins("crm").map((row) => row.id), ["airtable"]);
  assert.deepEqual(catalog.searchMarketplacePlugins("refund").map((row) => row.id), ["stripe"]);
  assert.deepEqual(catalog.searchMarketplacePlugins("newsletter").map((row) => row.id), ["resend"]);
  assert.deepEqual(catalog.searchMarketplacePlugins("wiki").map((row) => row.id), ["deepwiki", "notion"]);
  assert.equal(catalog.searchMarketplacePlugins("").length, catalog.MARKETPLACE_PLUGINS.length);
});

test("InstallPlugin writes the entry through the host path and answers with the empty fields", async () => {
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf8", mode: 0o600 });

  assert.equal(await host.marketplacePluginIsInstalled(reader, catalog.findMarketplacePlugin("tinyfish")), false);
  const outcome = await host.installMarketplacePlugin(reader, "tinyfish");
  assert.equal(outcome.installed, true);
  assert.equal(outcome.refused, undefined);

  // The file now carries the catalog's entry verbatim, and the credential is still only a name.
  // TinyFish is an endpoint, so what lands is the address and its headers, and the field the
  // operator owes is the ${...} in the Authorization header rather than an empty env key -- the
  // host reads the name back out of exactly that placeholder.
  const written = JSON.parse(readFileSync(CONNECTORS, "utf8")).mcpServers.tinyfish;
  assert.deepEqual(written, catalog.marketplaceConnectorEntry(catalog.findMarketplacePlugin("tinyfish")));
  assert.equal(written.headers.Authorization, "Bearer ${TINYFISH_API_KEY}");
  assert.equal(written.env, undefined, "a remote entry has no process, so it has no environment");

  // And the answer names the field the operator must fill, with nothing stored behind it.
  assert.deepEqual(outcome.fields.map((field) => [field.key, field.isStored]), [["TINYFISH_API_KEY", false]]);
  assert.ok(outcome.fields[0].hint.length > 0, "the field carries the line that says where the key is minted");

  const detail = await host.getMarketplacePluginDetail(reader, "tinyfish", []);
  assert.equal(detail.isInstalled, true);
  const described = tools.describePluginDetail(detail);
  assert.match(described, /TINYFISH_API_KEY \(required, not stored yet\)/);
  assert.ok(!described.includes("Setup fields (pass in InstallPlugin values)"), "the model is no longer told to pass values");
});

test("UninstallPlugin removes it and leaves connectors.json byte-identical", async () => {
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf8", mode: 0o600 });
  const before = readFileSync(CONNECTORS, "utf8");
  await host.installMarketplacePlugin(reader, "tinyfish");
  assert.notEqual(readFileSync(CONNECTORS, "utf8"), before);

  const outcome = host.uninstallMarketplacePlugin(reader, "tinyfish");
  assert.equal(outcome.removed, true);
  assert.equal(readFileSync(CONNECTORS, "utf8"), before, "the file is byte-identical after the undo");
  assert.equal(await host.marketplacePluginIsInstalled(reader, catalog.findMarketplacePlugin("tinyfish")), false);

  // A second uninstall is not an error, it is a no-op that says so.
  assert.equal(host.uninstallMarketplacePlugin(reader, "tinyfish").removed, false);
});

test("an install beside another connector touches only its own key", async () => {
  const neighbour = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], env: {} };
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: { localfiles: neighbour } }, null, 2), { encoding: "utf8", mode: 0o600 });
  const before = readFileSync(CONNECTORS, "utf8");
  await host.installMarketplacePlugin(reader, "github");
  const after = JSON.parse(readFileSync(CONNECTORS, "utf8")).mcpServers;
  assert.deepEqual(after.localfiles, neighbour);
  assert.ok(after.github != null);
  host.uninstallMarketplacePlugin(reader, "github");
  assert.equal(readFileSync(CONNECTORS, "utf8"), before);
});

test("the Custom MCP server card writes nothing: it is the connector editor", async () => {
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf8", mode: 0o600 });
  const before = readFileSync(CONNECTORS, "utf8");
  const editor = await host.installMarketplacePlugin(reader, "custom-mcp");
  assert.equal(editor.installed, false);
  assert.match(editor.refused, /connector editor/);
  assert.equal(readFileSync(CONNECTORS, "utf8"), before);
});

// A stored key and an installed program are two different facts, and conflating them was the bug:
// with TINYFISH_API_KEY in the store and `pip install cli-anything-tinyfish` never run, the tools
// told the model the CLI was available and it would run a command that does not exist. The converse
// was just as wrong -- a tool installed with no key read as "not installed", so the model told the
// operator to install what they already had.
test("a stored key alone is not an installed shell tool, and an install with no key still is one", async () => {
  const coderabbit = catalog.findMarketplacePlugin("coderabbit");
  writeFileSync(
    SECRETS,
    JSON.stringify({ shell: { CODERABBIT_API_KEY: "not-a-real-key" } }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  shellBinaries = new Set();
  assert.equal(await host.marketplacePluginIsInstalled(reader, coderabbit), false, "a key is not a program");
  // The key's truth is still told, in the one place it answers a question: the field.
  assert.deepEqual(
    host.marketplacePluginFields(reader, coderabbit).map((field) => [field.key, field.isStored]),
    [["CODERABBIT_API_KEY", true]],
  );

  // And the other way round: the program is there, the key is not.
  rmSync(SECRETS, { force: true });
  shellBinaries = new Set(["cr"]);
  assert.equal(await host.marketplacePluginIsInstalled(reader, coderabbit), true, "a program with no key is installed");
  assert.deepEqual(
    host.marketplacePluginFields(reader, coderabbit).map((field) => [field.key, field.isStored]),
    [["CODERABBIT_API_KEY", false]],
  );
  shellBinaries = new Set();
});

test("InstallPlugin runs a shell tool's installer instead of refusing it, and never rewrites an entry", async () => {
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: {} }, null, 2), { encoding: "utf8", mode: 0o600 });
  const before = readFileSync(CONNECTORS, "utf8");

  // Already installed: nothing is run, nothing is written, and the answer says which.
  shellBinaries = new Set(["cr"]);
  const already = await host.installMarketplacePlugin(reader, "coderabbit");
  assert.equal(already.installed, true);
  assert.match(already.refused, /already installed/);
  assert.equal(readFileSync(CONNECTORS, "utf8"), before, "a shell tool never touches connectors.json");
  shellBinaries = new Set();

  // A connector entry that is already there is left exactly as the operator has it.
  const edited = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--yolo"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "", EXTRA: "" } };
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: { github: edited } }, null, 2), { encoding: "utf8", mode: 0o600 });
  const untouched = readFileSync(CONNECTORS, "utf8");
  const second = await host.installMarketplacePlugin(reader, "github");
  assert.equal(second.installed, true);
  assert.match(second.refused, /already installed/);
  assert.equal(readFileSync(CONNECTORS, "utf8"), untouched, "the operator's edited entry survives a re-install");

  // Including one the operator has disabled, which the normalised read drops but a write must not.
  writeFileSync(CONNECTORS, JSON.stringify({ mcpServers: { github: { ...edited, disabled: true } } }, null, 2), { encoding: "utf8", mode: 0o600 });
  const disabled = readFileSync(CONNECTORS, "utf8");
  assert.match((await host.installMarketplacePlugin(reader, "github")).refused, /already installed/);
  assert.equal(readFileSync(CONNECTORS, "utf8"), disabled, "a disabled entry is still an entry");
});

test("the binary probe asks a real shell and answers false for a program nothing installed", async () => {
  const service = await bundle("source/host/extensions/shell-tools/shell-tools-service.ts", "shell-tools-service.cjs");
  assert.equal(await service.probeShellToolBinary({ binary: "sh" }), true);
  assert.equal(await service.probeShellToolBinary({ binary: "no-such-program-4f2a9c" }), false);
  // A name that is not a plain program name never reaches the shell.
  assert.equal(await service.probeShellToolBinary({ binary: "sh; touch /tmp/pwned" }), false);
});

test("the four plugin tools describe the Marketplace, not Cursor's", () => {
  const management = {
    listPlugins: async () => [], getPlugin: async () => null, install: async () => ({}),
    add: async () => [], listInstalled: async () => [], removeServer: async () => ({ removed: true, servers: [] }),
    uninstallPlugin: async () => ({ removed: true }), setInstructions: async () => [], restart: async () => [],
    authenticate: async () => ({ kind: "not-configured", serverName: "x" }),
    removeAccount: async () => [], renameAccount: async () => [],
  };
  const built = tools.createMcpManagementTools(management);
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool.descriptionGenerator()]));
  for (const name of ["SearchPlugins", "GetPlugin", "InstallPlugin", "UninstallPlugin"]) {
    assert.ok(byName[name] != null, `${name} is missing`);
    assert.ok(!/Cursor/.test(byName[name]), `${name} still names Cursor`);
    assert.match(byName[name], /Marketplace/, `${name} does not name the Marketplace`);
  }
  assert.match(byName.InstallPlugin, /cannot set a credential|CANNOT set a credential/i);
});
