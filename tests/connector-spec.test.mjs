// MARKET-6 / item A. The seam between what a plugin IS and how this box happens to run it, and the
// rules that keep a catalog row from lying.
//
// Three claims, and each one is a class of bug this wave was written to close:
//
//  1. THE SEAM HOLDS. A row declares a `ConnectorSpec` -- a program, or an endpoint. Exactly one
//     function turns one into a connectors.json entry, and it does so for every remote rung the
//     tree can be moved to (`bridge-argv`, `bridge-header-file`, `native`) without any row being
//     edited. That is what makes the custody fix a one-function change rather than a 19-row change.
//
//  2. NOTHING IN THE CATALOG IS A CREDENTIAL, and the validator is what enforces it rather than
//     the reviewer. A header value that carries a key, an env value that is not empty, a URL with
//     the key in its query string, an unpinned package: each is refused with a sentence.
//
//  3. NO ROW SHIPS UNVERIFIED. Every row carries `verification`, `documented` is refused outright,
//     and a row that installs a connector cannot claim the shell-tool proof. This is the test that
//     turns "do not ship an unverified preset as if it worked" from a promise into a gate.
//
// Nothing here touches a box, a network or a real credential. The only "values" anywhere are the
// empty string and obviously-invented text.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".connector-spec-test-"));
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

const spec = await bundle("source/shared/marketplace/connector-spec.ts", "connector-spec.cjs");
const catalog = await bundle("source/shared/marketplace/catalog.ts", "catalog-for-spec.cjs");

const REMOTE_MODES = ["bridge-argv", "bridge-header-file", "native"];

// ------------------------------------------------------------------ 1. the seam holds

test("every row materialises to a valid entry under every remote mode, and no row knows the bridge", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    const declared = catalog.marketplaceConnectorSpec(plugin);
    if (declared == null) continue;
    for (const mode of REMOTE_MODES) {
      const entry = catalog.marketplaceConnectorEntryOrRemote(plugin, { remoteMode: mode });
      assert.ok(entry != null, `${plugin.id} materialises to nothing under ${mode}`);
      if (declared.transport === "stdio") {
        assert.equal(entry.command, declared.command, `${plugin.id}: a program is its own entry`);
        continue;
      }
      if (mode === "native") {
        // The daemon's own remote shape: no process at all, and the header names survive.
        assert.equal(entry.type, declared.transport, `${plugin.id}: native entry type`);
        assert.equal(entry.url, declared.url, `${plugin.id}: native entry url`);
        assert.deepEqual(Object.keys(entry.headers).sort(), Object.keys(declared.headers).sort());
        continue;
      }
      // A bridged entry is a program, and the bridge is pinned.
      assert.equal(entry.command, "npx", `${plugin.id}: bridged entry command`);
      assert.ok(entry.args.includes(spec.MCP_REMOTE_PACKAGE), `${plugin.id}: the bridge is not pinned under ${mode}`);
      assert.ok(entry.args.includes(declared.url), `${plugin.id}: the bridged entry does not point at ${declared.url}`);
    }
  }
});

test("a header file rung carries no header value on the command line, and names a file per connector", () => {
  const remote = {
    transport: "http",
    url: "https://example.invalid/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
    env: { EXAMPLE_TOKEN: "" },
  };
  const argv = spec.connectorEntryFromSpec(remote, { remoteMode: "bridge-argv", connectorName: "example" });
  const file = spec.connectorEntryFromSpec(remote, { remoteMode: "bridge-header-file", connectorName: "example" });

  // Today's rung puts the placeholder on the command line, which is where the box's exec daemon
  // expands it into argv. That is the measured leak this ladder exists to climb off.
  assert.ok(argv.args.join(" ").includes("${EXAMPLE_TOKEN}"), "the argv rung is supposed to carry the placeholder");
  // The header-file rung carries the FILE, and no placeholder at all.
  assert.equal(file.args.join(" ").includes("${EXAMPLE_TOKEN}"), false, "the header-file rung still puts the field on the command line");
  assert.ok(file.args.includes("--header-file"), "the header-file rung does not use --header-file");
  assert.ok(file.args.includes(`${spec.MCP_REMOTE_HEADER_DIR}/example`), "the header file is not named after the connector");
  // And it refuses to guess a filename.
  assert.throws(() => spec.connectorEntryFromSpec(remote, { remoteMode: "bridge-header-file" }), /connectorName/);
});

test("the header file the host would write holds the value, and leaves an unstored field out", () => {
  const remote = {
    transport: "http",
    url: "https://example.invalid/mcp",
    headers: { Authorization: "Bearer ${A_TOKEN}", "X-Other": "${B_TOKEN}" },
    env: { A_TOKEN: "", B_TOKEN: "" },
  };
  const lines = spec.remoteHeaderFileLines(remote, { A_TOKEN: "value-a" });
  assert.equal(lines, "Authorization: Bearer value-a\n");
  // Nothing stored at all is an empty file, not a file of empty headers: "no Authorization header"
  // and "an Authorization header with nothing in it" are different failures, and the first is honest.
  assert.equal(spec.remoteHeaderFileLines(remote, {}), "");
});

// ------------------------------------------------------------------ 2. nothing in it is a credential

test("a remote URL that is itself the credential, or points inside the box, is refused", () => {
  const refused = [
    ["http://example.com/mcp", /must be https/],
    ["https://user:pass@example.com/mcp", /credential in the address itself/],
    ["https://example.com/mcp?api_key=abcdef0123456789", /query string/],
    ["https://example.com/mcp?token=abcdef0123456789", /query string/],
    ["https://localhost/mcp", /points inside the box/],
    ["https://127.0.0.1/mcp", /private address/],
    ["https://10.1.2.3/mcp", /private address/],
    ["https://192.168.1.10/mcp", /private address/],
    ["https://172.16.4.4/mcp", /private address/],
    ["https://169.254.169.254/mcp", /private address/],
    // MARKET-22. The same four addresses written the other way. Each of these was ACCEPTED by the
    // shipped validators until the hostname was normalized before it was tested -- measured
    // against the live gateway on the R750 demo box on 2026-09-08, where `[::ffff:127.0.0.1]:1341`
    // and `[::]:1341` and `[::ffff:169.254.169.254]` all took a secret Authorization header while
    // the plain `127.0.0.1` form was refused.
    ["https://[::ffff:127.0.0.1]:1341/mcp", /private address/],
    ["https://[::ffff:7f00:1]:1341/mcp", /private address/],
    ["https://[::]:1341/mcp", /points inside the box/],
    ["https://[::1]:1341/mcp", /points inside the box/],
    ["https://[::ffff:169.254.169.254]/mcp", /private address/],
    ["https://[::ffff:192.168.48.6]:1340/mcp", /private address/],
    ["https://[fd00::1]/mcp", /private address/],
    ["not-a-url", /not a URL/],
  ];
  for (const [url, shape] of refused) {
    const problem = spec.remoteMcpUrlProblem("the server", url);
    assert.ok(problem != null, `${url} was accepted`);
    assert.match(problem, shape, url);
  }
  // And the ones that must go through.
  // A global-unicast v6 address is a real server and stays addable, coat and all.
  for (const url of ["https://mcp.example.com/mcp", "https://example.com/mcp?version=2", "https://[2606:4700::1111]/mcp"]) {
    assert.equal(spec.remoteMcpUrlProblem("the server", url), null, url);
  }
});

test("a package argument with no version is refused, for both package managers", () => {
  assert.equal(spec.unpinnedPackageArgument("npx", ["-y", "some-server"]), "some-server");
  assert.equal(spec.unpinnedPackageArgument("npx", ["-y", "@scope/some-server"]), "@scope/some-server");
  assert.equal(spec.unpinnedPackageArgument("npx", ["-y", "some-server@1.2.3"]), null);
  assert.equal(spec.unpinnedPackageArgument("npx", ["-y", "@scope/some-server@1.2.3"]), null);
  assert.equal(spec.unpinnedPackageArgument("uvx", ["some-server"]), "some-server");
  assert.equal(spec.unpinnedPackageArgument("uvx", ["some-server==0.3.0"]), null);
  // A command that is not a package runner is not this rule's business.
  assert.equal(spec.unpinnedPackageArgument("/usr/bin/my-server", ["--flag"]), null);
});

// A remote row runs no package at all on the native rung, so there is nothing to pin; what has to
// stay pinned is every entry that IS a program, on whichever rung produced it.
test("every package argument in the catalog is pinned", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    for (const mode of REMOTE_MODES) {
      const bridged = catalog.marketplaceConnectorEntry(plugin, { remoteMode: mode });
      if (bridged == null || bridged.command === undefined) continue;
      assert.equal(
        spec.unpinnedPackageArgument(bridged.command, bridged.args), null,
        `plugin ${plugin.id} runs an unpinned package under ${mode}; it is a different program every few weeks`,
      );
    }
    const entry = catalog.marketplaceConnectorEntry(plugin);
    if (entry == null || entry.command === undefined) continue;
    assert.equal(
      spec.unpinnedPackageArgument(entry.command, entry.args), null,
      `plugin ${plugin.id} runs an unpinned package; it is a different program every few weeks`,
    );
  }
});

test("every credential env value in the catalog is the empty string, and configuration is declared", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    const declared = catalog.marketplaceConnectorSpec(plugin);
    if (declared == null) continue;
    for (const [field, value] of Object.entries(declared.env)) {
      assert.equal(value, "", `plugin ${plugin.id} gives env ${field} a value in its spec`);
    }
    // The materialised entry may add configuration, and only what the catalog declares as such. A
    // remote entry has no env at all on the native rung, so there is nothing here to check: the
    // fields it owes are ${FIELD} placeholders in its headers, which the refusal tests cover.
    const entry = catalog.marketplaceConnectorEntry(plugin);
    for (const [field, value] of Object.entries(entry?.env ?? {})) {
      assert.ok(
        value === "" || catalog.MARKETPLACE_CONFIGURATION_ENV_KEYS.includes(field),
        `plugin ${plugin.id} gives env ${field} a non-empty value that is not declared configuration`,
      );
    }
  }
});

test("a spec with a key-shaped header literal is refused, and a configuration header is not", () => {
  const withSecret = {
    transport: "http", url: "https://example.invalid/mcp",
    headers: { Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, env: {},
  };
  const problems = spec.connectorSpecProblems("the server", withSecret);
  assert.ok(problems.some((line) => /shaped like a key/.test(line)), problems.join("\n"));

  // GitHub's toolset headers select which tools the server exposes. They are no more secret than
  // the URL, and refusing them would have made the one row with real scoping unshippable.
  const withConfig = {
    transport: "http", url: "https://example.invalid/mcp",
    headers: { "X-MCP-Readonly": "true", Authorization: "Bearer ${A_TOKEN}" }, env: { A_TOKEN: "" },
  };
  assert.deepEqual(spec.connectorSpecProblems("the server", withConfig), []);

  // A placeholder naming a field the entry never declares is a card that can never be filled.
  const orphan = {
    transport: "http", url: "https://example.invalid/mcp",
    headers: { Authorization: "Bearer ${NOT_DECLARED}" }, env: {},
  };
  assert.ok(spec.connectorSpecProblems("the server", orphan).some((line) => /does not declare/.test(line)));
});

// ------------------------------------------------------------------ 3. no row ships unverified

test("the catalog validates clean, and the validator is not vacuous", () => {
  assert.deepEqual(catalog.validateMarketplaceCatalog(), []);

  // Each of these is a row that must NOT be allowed through, so that a green suite means something.
  const base = catalog.MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "context7");
  const withPlugins = (plugin) => catalog.validateMarketplaceCatalog({
    plugins: [plugin], bots: [], categories: catalog.MARKETPLACE_CATALOG.categories,
  });

  const documented = { ...base, id: "x-documented", connectorName: "x-documented", verification: { ...base.verification, proof: "documented" } };
  assert.ok(withPlugins(documented).some((line) => /only by reading the vendor's documentation/.test(line)));

  const unstamped = { ...base, id: "x-unstamped", connectorName: "x-unstamped", verification: undefined };
  assert.ok(withPlugins(unstamped).some((line) => /carries no verification stamp/.test(line)));

  const installerProof = { ...base, id: "x-installer", connectorName: "x-installer", verification: { ...base.verification, proof: "vendor-installer" } };
  assert.ok(withPlugins(installerProof).some((line) => /has to be that the connector ran/.test(line)));

  const hintless = {
    ...base, id: "x-hintless", connectorName: "x-hintless",
    install: { connector: { transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${T}" }, env: { T: "" } } },
    credentials: [{ field: "T", label: "T", hint: "   ", consumers: [{ kind: "connector", env: "T" }] }],
  };
  assert.ok(withPlugins(hintless).some((line) => /has no hint/.test(line)));

  const consumerless = {
    ...base, id: "x-consumerless", connectorName: "x-consumerless",
    install: { connector: { transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${T}" }, env: { T: "" } } },
    credentials: [{ field: "T", label: "T", hint: "somewhere you mint it", consumers: [] }],
  };
  assert.ok(withPlugins(consumerless).some((line) => /names no consumer/.test(line)));

  // A credential field the entry leaves empty and the row never declares: a masked box with no
  // sentence under it, which is exactly the CONNECT-4 bug.
  const undeclared = {
    ...base, id: "x-undeclared", connectorName: "x-undeclared",
    install: { connector: { transport: "stdio", command: "npx", args: ["-y", "thing@1.0.0"], env: { SOME_TOKEN: "" } } },
    credentials: [],
  };
  assert.ok(withPlugins(undeclared).some((line) => /declares no credential for it/.test(line)));

  const noKeywords = { ...base, id: "x-nokeywords", connectorName: "x-nokeywords", keywords: [] };
  assert.ok(withPlugins(noKeywords).some((line) => /carries no keywords/.test(line)));

  const badUrl = {
    ...base, id: "x-badurl", connectorName: "x-badurl",
    install: { connector: { transport: "http", url: "https://127.0.0.1/mcp", headers: {}, env: {} } },
  };
  assert.ok(withPlugins(badUrl).some((line) => /private address/.test(line)));
});

test("two rows may not claim one connector name", () => {
  const [first, second] = catalog.MARKETPLACE_PLUGINS.filter((plugin) => plugin.connectorName != null);
  const problems = catalog.validateMarketplaceCatalog({
    plugins: [first, { ...second, id: "x-clash", connectorName: first.connectorName }],
    bots: [], categories: catalog.MARKETPLACE_CATALOG.categories,
  });
  assert.ok(problems.some((line) => /both claim the connector name/.test(line)), problems.join("\n"));
});

test("no two rows in the shipped catalog share a connector name, and every row is stamped", () => {
  const names = new Map();
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    assert.ok(plugin.verification != null, `plugin ${plugin.id} has no verification stamp`);
    assert.notEqual(plugin.verification.proof, "documented", `plugin ${plugin.id} ships on documentation alone`);
    assert.match(plugin.verification.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `plugin ${plugin.id} verification date`);
    assert.ok(plugin.verification.how.length >= 40, `plugin ${plugin.id} does not say what was done`);
    if (plugin.connectorName == null) continue;
    assert.equal(names.get(plugin.connectorName), undefined, `two rows claim "${plugin.connectorName}"`);
    names.set(plugin.connectorName, plugin.id);
  }
});

test("a tagline may not answer a search the plugin tools pin with deepEqual", () => {
  const base = catalog.MARKETPLACE_PLUGINS.find((plugin) => plugin.id === "context7");
  const problems = catalog.validateMarketplaceCatalog({
    plugins: [{ ...base, id: "x-kubernetes", connectorName: "x-kubernetes", tagline: "Run kubernetes jobs" }],
    bots: [], categories: catalog.MARKETPLACE_CATALOG.categories,
  });
  assert.ok(problems.some((line) => /answers the pinned search "kubernetes"/.test(line)), problems.join("\n"));
  // The words owners actually type live in keywords, which those searches do not read.
  const fine = catalog.validateMarketplaceCatalog({
    plugins: [{ ...base, id: "x-fine", connectorName: "x-fine", keywords: ["kubernetes", "cluster"] }],
    bots: [], categories: catalog.MARKETPLACE_CATALOG.categories,
  });
  assert.deepEqual(fine, []);
});

// ------------------------------------------------------------------ the credential fan-out (MARKET-5)

test("a credential declares every place one write has to reach, and the consumers are real", () => {
  const github = catalog.findMarketplacePlugin("github");
  const token = catalog.marketplaceCredential(github, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.ok(token != null);
  // One typed value, three destinations -- and the two env names differ, which is the thing the
  // old one-hint-per-env-name map could not express without asking for the same string twice.
  assert.deepEqual(token.consumers, [
    { kind: "connector", env: "GITHUB_PERSONAL_ACCESS_TOKEN" },
    { kind: "header", name: "Authorization" },
    { kind: "shell", env: "GITHUB_TOKEN" },
  ]);

  // TinyFish is the row the complaint was about: one product, one box to type in, two consumers.
  const tinyfish = catalog.findMarketplacePlugin("tinyfish");
  assert.equal(tinyfish.credentials.length, 1, "TinyFish is one credential, not two forms");
  assert.equal(catalog.marketplaceShellToolId(tinyfish), "tinyfish-cli", "the CLI folded in, so one key feeds both");
  const kinds = tinyfish.credentials[0].consumers.map((consumer) => consumer.kind).sort();
  assert.deepEqual(kinds, ["connector", "header", "shell"]);

  // Every consumer of every row resolves against something that exists. The validator says so; this
  // asserts the validator was actually asked.
  assert.deepEqual(catalog.validateMarketplaceCatalog(), []);
});

test("every credential field has a hint, and the derived hint map still answers by env name", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    const hints = catalog.marketplaceCredentialHints(plugin);
    for (const field of catalog.marketplaceCredentialFields(plugin)) {
      assert.ok(hints[field]?.length > 20, `plugin ${plugin.id} field ${field} has no usable hint`);
    }
    assert.deepEqual(Object.keys(hints).sort(), [...catalog.marketplaceCredentialFields(plugin)].sort());
  }
});

// ------------------------------------------------------------------ the wire keeps its old shape

test("the wire view still speaks kind, install and credentialHints", () => {
  const wire = catalog.marketplaceCatalogWireView();
  assert.equal(wire.plugins.length, catalog.MARKETPLACE_PLUGINS.length);
  const byId = Object.fromEntries(wire.plugins.map((plugin) => [plugin.id, plugin]));

  // A connector row: install is the entry the box would write. Linear is an endpoint, and on the
  // native rung that entry is the address and its headers rather than a bridge to run.
  assert.equal(byId.linear.kind, "connector");
  assert.equal(typeof byId.linear.install, "object");
  assert.equal(byId.linear.install.url, "https://mcp.linear.app/mcp");
  assert.equal(byId.linear.install.type, "http");
  assert.ok(byId.linear.credentialHints.LINEAR_API_KEY.length > 0);

  // A program row still says the program.
  assert.equal(byId.notion.install.command, "npx");

  // A shell-tool row: install is the shell tool's id, which is what the console's Add routes on.
  assert.equal(byId.coderabbit.kind, "shell-tool");
  assert.equal(byId.coderabbit.install, "coderabbit");

  // The editor card installs nothing, and says so the way the console already reads it.
  assert.equal(byId["custom-mcp"].install, null);
  assert.equal(byId["custom-mcp"].opensEditor, true);

  // And the new vocabulary rides along beside the old one.
  assert.ok(Array.isArray(byId.linear.credentials));
  assert.ok(byId.linear.verification.proof.length > 0);
});
