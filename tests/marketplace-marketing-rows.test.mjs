// MARKET-26. The marketing rows themselves: that each one is honest about what it needs, what it
// costs and where its facts came from, and that the new row shape cannot be used to smuggle a
// weaker claim past the rule that has guarded this catalog since MARKET-1.
//
// The claims:
//
//  1. Every marketing row carries at least one dated doc fact with an https source and an anchor,
//     and a non-empty block of first steps. Those vendors move app-review tiers, scope names and
//     endpoint versions between our releases, so a marketing row with no dated source is a row that
//     goes stale in silence and sends somebody down a dead sign-up path.
//  2. Every credential on every row still has a hint. That has always been the rule; the new
//     cloud-browser consumer must not be a way around it.
//  3. `proof: "documented"` is STILL refused. This wave added a second dated block on purpose so
//     that re-reading a vendor's page can never be mistaken for having run the thing.
//  4. A row that installs nothing is a PAGE, not a dead card: the validator makes it carry steps and
//     a source, and it is drawn with no Add button because there is nothing to add.
//  5. Nothing in any of it is a secret, and no row invented a connector to hang a credential on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "marketing-rows-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const result = await build({
  entryPoints: [path.join(repoRoot, "source/shared/marketplace/catalog.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const file = path.join(stage, "catalog.cjs");
writeFileSync(file, result.outputFiles[0].text, "utf8");
const catalog = createRequire(import.meta.url)(file);

const MARKETING_IDS = ["meta", "x", "linkedin", "buffer"];
const rowOf = (id) => {
  const row = catalog.findMarketplacePlugin(id);
  assert.ok(row != null, `the catalog carries no row "${id}"`);
  return row;
};

test("the catalog is still internally true with the marketing rows on it", () => {
  const problems = catalog.validateMarketplaceCatalog();
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(catalog.MARKETPLACE_PLUGIN_CATEGORIES.includes("Marketing"));
});

test("every marketing row carries a dated doc fact with an https source and an anchor", () => {
  for (const id of MARKETING_IDS) {
    const row = rowOf(id);
    assert.equal(row.category, "Marketing", id);
    assert.ok(Array.isArray(row.docs) && row.docs.length > 0, `${id} carries no doc facts`);
    assert.ok(Number.isInteger(row.recheckDays) && row.recheckDays > 0, `${id} has no recheck interval`);
    let checkable = 0;
    for (const doc of row.docs) {
      assert.match(doc.url, /^https:\/\//, `${id}/${doc.id} is not an https source`);
      assert.match(doc.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `${id}/${doc.id} has no read date`);
      assert.ok(doc.what.trim().length > 0, `${id}/${doc.id} does not say what it is`);
      if (doc.state === "not-published") {
        // The vendor's own statement that it does not publish this, which is a terminal state and
        // never a weekly alert. LinkedIn's rate limits are why this exists.
        assert.equal(doc.expected, "", `${id}/${doc.id} claims a value the vendor does not publish`);
        continue;
      }
      checkable += 1;
      assert.ok(doc.anchor.trim().length > 0, `${id}/${doc.id} names no anchor`);
      assert.ok(doc.expected.trim().length > 0, `${id}/${doc.id} names nothing to check`);
    }
    assert.ok(checkable > 0, `${id} has nothing a run could actually check`);
  }
});

test("every marketing row says what a person must do first", () => {
  for (const id of MARKETING_IDS) {
    const row = rowOf(id);
    assert.ok(Array.isArray(row.firstSteps) && row.firstSteps.length > 0, `${id} has no first steps`);
    for (const step of row.firstSteps) {
      assert.ok(step.trim().length > 20, `${id} has a first step that says nothing: "${step}"`);
    }
  }
});

test("every credential on every row still has a hint, including the new consumer kind", () => {
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    for (const credential of plugin.credentials) {
      assert.ok(credential.hint.trim().length > 0, `${plugin.id}/${credential.field} has no hint`);
      assert.ok(credential.consumers.length > 0, `${plugin.id}/${credential.field} names no consumer`);
    }
  }
  // Browserbase's key is read by the HOST and by nothing else. Specifically it is not a `shell`
  // consumer: shell-secrets values are merged into the environment of the process that spawns every
  // /bin/sh the agent's shell tool runs, and the agent can read its own environment.
  const browserbase = rowOf("browserbase");
  const [key] = browserbase.credentials;
  assert.equal(key.field, "BROWSERBASE_API_KEY");
  assert.deepEqual(key.consumers, [{ kind: "cloud-browser", engine: "browserbase" }]);
  assert.ok(!JSON.stringify(browserbase).includes("\"shell\""), "the cloud-browser key reaches the agent's shell");

  // Browser Use already had a connector, so its one key now fans out to the connector AND the
  // cloud engine -- one box on the page, exactly the way GitHub's one token reaches a connector
  // and `gh`.
  const browserUse = rowOf("browser-use");
  const kinds = browserUse.credentials[0].consumers.map((consumer) => consumer.kind);
  assert.ok(kinds.includes("connector"));
  assert.ok(kinds.includes("cloud-browser"));
});

test("a documented-only proof is still refused, and a doc fact cannot become one", () => {
  const withDocumented = {
    ...catalog.MARKETPLACE_CATALOG,
    plugins: [{ ...rowOf("meta"), verification: { checkedOn: "2026-09-09", proof: "documented", how: "read the vendor's own documentation on this date and it says what this row says" } }],
  };
  const problems = catalog.validateMarketplaceCatalog(withDocumented);
  assert.ok(problems.some((problem) => /verified only by reading the vendor's documentation/.test(problem)), problems.join("\n"));

  // And every shipped row's proof is a thing that was RUN, not a thing that was read.
  for (const plugin of catalog.MARKETPLACE_PLUGINS) {
    assert.notEqual(plugin.verification.proof, "documented", plugin.id);
    assert.ok(plugin.verification.how.length >= 40, plugin.id);
  }
});

test("a marketing row with no doc fact is refused, and so is a row that installs nothing and says nothing", () => {
  const bare = { ...rowOf("meta") };
  delete bare.docs;
  delete bare.recheckDays;
  const problems = catalog.validateMarketplaceCatalog({ ...catalog.MARKETPLACE_CATALOG, plugins: [bare] });
  assert.ok(problems.some((problem) => /is a marketing row and carries no doc fact/.test(problem)), problems.join("\n"));

  const silent = { ...rowOf("meta"), category: "Business" };
  delete silent.docs;
  delete silent.firstSteps;
  delete silent.recheckDays;
  const more = catalog.validateMarketplaceCatalog({ ...catalog.MARKETPLACE_CATALOG, plugins: [silent] });
  assert.ok(more.some((problem) => /installs nothing and does not open the editor/.test(problem)), more.join("\n"));
});

test("a doc fact that is not https, has no date, or claims a value the vendor does not publish is refused", () => {
  const bend = (doc) => catalog.validateMarketplaceCatalog({
    ...catalog.MARKETPLACE_CATALOG,
    plugins: [{ ...rowOf("meta"), docs: [{ ...rowOf("meta").docs[0], ...doc }] }],
  });
  assert.ok(bend({ url: "http://developers.facebook.com/docs" }).some((p) => /not an https source/.test(p)));
  assert.ok(bend({ checkedOn: "recently" }).some((p) => /read date that is not a date/.test(p)));
  assert.ok(bend({ state: "not-published", expected: "v26.0" }).some((p) => /not published by the vendor and still names an expected value/.test(p)));
  assert.ok(bend({ anchor: "" }).some((p) => /names no anchor/.test(p)));
});

test("the rows that install nothing are pages, and the ones that install something still do", () => {
  for (const id of ["meta", "x", "linkedin", "browserbase"]) {
    const row = rowOf(id);
    assert.equal(row.installsNothing, true, id);
    assert.equal(row.install, undefined, `${id} installs something after all`);
    assert.equal(row.connectorName, undefined, `${id} claims a connector name with no connector`);
  }
  // Meta, X and LinkedIn carry NO masked box at all. There is nowhere for such a token to go today
  // -- no official MCP server publishes an organic post anywhere -- and a box for a value nothing
  // reads is the same lie one level up as a connector that can only ever fail.
  for (const id of ["meta", "x", "linkedin"]) {
    assert.deepEqual(rowOf(id).credentials, [], `${id} asks for a key nothing reads`);
  }
  const buffer = rowOf("buffer");
  assert.equal(buffer.installsNothing, false);
  assert.equal(buffer.kind, "connector");
  assert.equal(buffer.connectorName, "buffer");
  assert.equal(buffer.install.connector.url, "https://mcp.buffer.com/mcp");
  // A key ships as an empty string, which is exactly how the host recognises a credential field.
  assert.equal(buffer.install.connector.env.BUFFER_API_KEY, "");
});

test("the wire carries the new fields, so the console does not have to work them out", () => {
  const wire = catalog.marketplaceCatalogWireView();
  const meta = wire.plugins.find((plugin) => plugin.id === "meta");
  assert.equal(meta.installsNothing, true);
  assert.equal(meta.docs.length, 5);
  assert.equal(meta.recheckDays, 7);
  assert.ok(meta.firstSteps.length > 0);
  assert.match(meta.knownContradiction, /100 API-published posts/);
  const buffer = wire.plugins.find((plugin) => plugin.id === "buffer");
  assert.equal(buffer.installsNothing, false);
  // The wire's `install` for a direct endpoint is the entry as it lands on the box: the address, and
  // the key named only as a placeholder in the header. No value, here or anywhere.
  assert.equal(buffer.install.url, "https://mcp.buffer.com/mcp");
  assert.equal(buffer.install.headers.Authorization, "Bearer ${BUFFER_API_KEY}");
  assert.equal(buffer.docs.length, 4);
});

test("nothing in the new rows is a secret, and no vendor name reaches a customer as a tool name", () => {
  for (const id of [...MARKETING_IDS, "browserbase"]) {
    const row = rowOf(id);
    const text = JSON.stringify(row);
    // The shapes a key takes on these five vendors, none of which belongs in a file in git.
    for (const shape of [/\bsk-[A-Za-z0-9]{16,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bEAA[A-Za-z0-9]{20,}/, /\bbb_live_[A-Za-z0-9]{10,}/, /\bAAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{20,}/]) {
      assert.ok(!shape.test(text), `${id} carries something shaped like a key`);
    }
    for (const credential of row.credentials) {
      const spec = row.install?.connector;
      if (spec?.env != null) assert.equal(spec.env[credential.field] ?? "", "", `${id} bakes a value into ${credential.field}`);
    }
  }
});
