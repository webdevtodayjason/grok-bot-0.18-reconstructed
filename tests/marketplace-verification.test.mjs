// MARKET-26. The recurring re-read of the vendor documentation the marketing rows depend on.
//
// The claims here are the ones that decide whether this job is worth running at all, because a
// differ that cries wolf gets muted inside a month and a differ that stays quiet is worse than none:
//
//  1. A FIXTURE DOC CHANGED UNDER TEST FLIPS ITS ROW IN ONE RUN, and the record names which fact
//     moved and quotes BOTH SIDES of it. That is the whole promise.
//  2. AN UNCHANGED FIXTURE LEAVES THE ROW ALONE ACROSS THREE RUNS. No thrash: a job that reported a
//     change every week would be indistinguishable from one that never worked.
//  3. A 404 FLIPS THE ROW, and so does landing somewhere the row does not name. Four of the URLs a
//     plausible 2025-era row would carry are dead today, so a 404 is a change and never a pass.
//  4. AN EDITED SUNSET BANNER AND AN EDITED LEFT NAV FLIP NOTHING -- not the state and not even the
//     digest. Both were measured on real pages on 2026-09-09: LinkedIn renders a deprecation banner
//     whose sunset date is three weeks in the past, and canva.dev prepends a section nav that grows
//     whenever the site does.
//  5. A NOT-PUBLISHED FACT NEVER FLIPS. LinkedIn states it does not publish its rate limits; a job
//     that turned that absence into a weekly alert would be reporting LinkedIn's policy as news.
//  6. NO DOC RESULT EVER RAISES verification.proof. The two dated facts stay two dated facts.
//  7. A PAGE WE COULD NOT READ IS NOT A CHANGED PAGE. A JavaScript shell is its own outcome.
//
// Nothing here touches the network. Every page is a string in this file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  DEFAULT_RECHECK_DAYS,
  VERIFICATION_FEEDBACK_SETTING,
  VERIFICATION_RUN_SETTING,
  VERIFICATION_SETTING_PREFIX,
  checkDoc,
  docNoiseRules,
  fixtureFetcher,
  fixtureKey,
  htmlToPlainText,
  loadCatalogPlugins,
  readCatalogPlugins,
  readRecord,
  rowAge,
  rowState,
  rowsWithDocs,
  stampCatalogSource,
  stripDocNoise,
  stripNavPrefix,
  verifyCatalog,
  verifyRow,
} from "../cp/verification.mjs";

const root = mkdtempSync(path.join(tmpdir(), "marketplace-verification-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** The control plane's settings table, as much of it as this job uses. */
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    getSetting: (name, fallback = "") => (rows.has(name) ? rows.get(name).value : fallback),
    setSetting: (name, value, actor = "") => { rows.set(name, { name, value, at: Date.now(), actor }); },
    listSettings: () => [...rows.values()],
  };
}

/** One fixture page on disk, addressed the way the fetcher addresses it. */
function putFixture(dir, url, body) {
  writeFileSync(path.join(dir, `${fixtureKey(url)}.html`), body, "utf8");
}

const LINKEDIN_BANNER = "Warning Deprecation Notice: The Marketing Version 202508 (Marketing August 2025) will be sunset on August 17, 2026. We recommend that you migrate to the latest versioned APIs to avoid disruptions. For information on all the supported versions, refer to the migrations documentation. If you haven't yet migrated and have questions, submit a request on the LinkedIn Developer Support Portal.";

const PERMISSION_PAGE = (permission) => `<html><body><h1>Permissions Reference</h1>
<table><tr><td><code>${permission}</code></td><td>Lets an app create, edit and delete Page posts.</td></tr></table>
</body></html>`;

const ROW = Object.freeze({
  id: "fixturevendor",
  name: "Fixture Vendor",
  category: "Marketing",
  recheckDays: 7,
  docs: Object.freeze([
    Object.freeze({
      id: "post-permission",
      what: "The permission that lets an app create a post",
      url: "https://vendor.invalid/docs/permissions",
      anchor: "Permissions Reference",
      expected: "pages_manage_posts",
      checkedOn: "2026-09-09",
      state: "verified",
    }),
    Object.freeze({
      id: "rate-limits",
      what: "The per-app rate limits",
      url: "https://vendor.invalid/docs/rate-limits",
      anchor: "",
      expected: "",
      checkedOn: "2026-09-09",
      state: "not-published",
    }),
  ]),
});

test("a fixture doc changed under test flips the row inside one run, and names both sides", async () => {
  const dir = mkdtempSync(path.join(root, "flip-"));
  putFixture(dir, ROW.docs[0].url, PERMISSION_PAGE("pages_manage_posts"));
  const store = fakeStore();

  const first = await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  assert.equal(first.records[0].state, "verified");
  assert.deepEqual(first.rollup.needsReVerification, []);

  // The vendor renames the permission. One run, and the row moves.
  putFixture(dir, ROW.docs[0].url, PERMISSION_PAGE("pages_manage_content"));
  const second = await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  const record = second.records[0];
  assert.equal(record.state, "needs-re-verification");
  assert.deepEqual(second.rollup.needsReVerification, ["fixturevendor"]);

  assert.equal(record.changed.length, 1);
  const change = record.changed[0];
  assert.equal(change.docId, "post-permission");
  assert.equal(change.what, "The permission that lets an app create a post");
  // BOTH SIDES, quoted. Without the second one an operator has to go and read the vendor's page to
  // find out what the word "changed" meant, which is the work this job exists to have already done.
  assert.equal(change.expected, "pages_manage_posts");
  assert.match(change.found, /pages_manage_content/);
  assert.equal(change.url, "https://vendor.invalid/docs/permissions");

  // And it landed where the panel and the CLI read it from.
  const stored = readRecord(store, "fixturevendor");
  assert.equal(stored.state, "needs-re-verification");
  assert.ok(store.rows.has(`${VERIFICATION_SETTING_PREFIX}fixturevendor`));
  assert.ok(store.rows.has(VERIFICATION_RUN_SETTING));
});

test("an unchanged fixture leaves the row alone across three runs", async () => {
  const dir = mkdtempSync(path.join(root, "steady-"));
  putFixture(dir, ROW.docs[0].url, PERMISSION_PAGE("pages_manage_posts"));
  const store = fakeStore();
  const digests = [];
  for (let run = 0; run < 3; run += 1) {
    const answer = await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
    assert.equal(answer.records[0].state, "verified", `run ${run + 1}`);
    assert.equal(answer.records[0].changed.length, 0, `run ${run + 1}`);
    digests.push(answer.records[0].docs[0].digest);
  }
  assert.equal(new Set(digests).size, 1, "three runs against the same page produced three different digests");
});

test("a 404 flips the row, and so does landing somewhere the row does not name", async () => {
  const store = fakeStore();
  // No fixture written at all, so the fetcher answers 404 the way a dead vendor URL does.
  const gone = await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(mkdtempSync(path.join(root, "gone-"))), store, source: "test" });
  assert.equal(gone.records[0].state, "needs-re-verification");
  assert.match(gone.records[0].changed[0].reason, /answered 404/);

  const moved = await verifyRow(ROW, {
    fetchDoc: async (url) => ({
      ok: true, status: 200, url,
      finalUrl: "https://vendor.invalid/pricing",
      contentType: "text/html",
      body: PERMISSION_PAGE("pages_manage_posts"),
    }),
  });
  assert.equal(moved.state, "needs-re-verification");
  assert.match(moved.changed[0].reason, /now lands on https:\/\/vendor\.invalid\/pricing/);
});

test("a redirect the row already records is not a change", async () => {
  const row = { ...ROW, docs: [{ ...ROW.docs[0], finalUrl: "https://vendor.invalid/documentation/permissions" }, ROW.docs[1]] };
  const answer = await verifyRow(row, {
    fetchDoc: async (url) => ({
      ok: true, status: 200, url,
      finalUrl: "https://vendor.invalid/documentation/permissions",
      contentType: "text/html",
      body: PERMISSION_PAGE("pages_manage_posts"),
    }),
  });
  assert.equal(answer.state, "verified");
});

test("an edited sunset banner and an edited left nav flip nothing, not even the digest", async () => {
  const url = ROW.docs[0].url;
  const page = (banner, nav) => `${nav}\n\n# Permissions Reference\n\n${banner}\n\nThe pages_manage_posts permission lets an app create, edit and delete Page posts.`;
  const nav = "Getting started\n\nOverviewQuickstartCreating integrations\n\nReference apps\n\nDev MCP server";
  const grownNav = `${nav}\n\nBrand kits\n\nWebhooks`;
  const laterBanner = LINKEDIN_BANNER.replace("202508", "202510").replace("August 17, 2026", "October 20, 2026");

  const read = async (body) => verifyRow(ROW, {
    fetchDoc: async (u) => ({ ok: true, status: 200, url: u, finalUrl: u, contentType: "text/markdown", text: body }),
  });

  const before = await read(page(LINKEDIN_BANNER, nav));
  const after = await read(page(laterBanner, grownNav));
  assert.equal(before.state, "verified");
  assert.equal(after.state, "verified");
  // The digest is of the noise-stripped section. If the boilerplate reached it, this is where a
  // weekly run would start reporting a change nobody made.
  assert.equal(before.docs[0].digest, after.docs[0].digest);
  assert.ok(docNoiseRules().length >= 4, docNoiseRules().join(", "));
});

test("a not-published fact never flips, and is never fetched", async () => {
  let asked = 0;
  const answer = await verifyRow(ROW, {
    fetchDoc: async (url) => { asked += 1; return { ok: true, status: 200, url, finalUrl: url, contentType: "text/html", body: PERMISSION_PAGE("pages_manage_posts") }; },
  });
  assert.equal(asked, 1, "the not-published fact was fetched");
  const notPublished = answer.docs.find((doc) => doc.id === "rate-limits");
  assert.equal(notPublished.state, "not-published");
  assert.equal(answer.state, "verified");
  assert.equal(answer.changed.length, 0);
});

test("a page that came back as a shell is not measured, and is not a change either", async () => {
  const shell = `<html><head><title>Docs</title></head><body><div id="root"></div><script>${"x".repeat(60_000)}</script></body></html>`;
  const answer = await verifyRow(ROW, {
    fetchDoc: async (url) => ({ ok: true, status: 200, url, finalUrl: url, contentType: "text/html", body: shell }),
  });
  assert.equal(answer.state, "not-measured");
  assert.equal(answer.changed.length, 0, "a page this container cannot render was reported as a vendor change");
  assert.equal(answer.unreadable.length, 1);
  assert.match(answer.unreadable[0].reason, /shell rather than a page/);
  assert.equal(rowState([{ state: "changed" }, { state: "unreadable" }]), "needs-re-verification");
});

test("no doc result ever raises a row's verification proof", async () => {
  // The catalog's own rows, run against fixtures that all pass. `verification` is not in the record
  // at all: this job cannot write it, name it, or reach it.
  const dir = mkdtempSync(path.join(root, "proof-"));
  const store = fakeStore();
  const answer = await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  const serialised = JSON.stringify(answer);
  assert.ok(!serialised.includes("\"proof\""), "a verification proof appeared in a doc-check record");
  assert.ok(!serialised.includes("tools-listed"));
  assert.ok(!serialised.includes("endpoint-answered"));

  // And the stamp writer touches only the two fields it says it touches.
  const source = readFileSync(new URL("../source/shared/marketplace/catalog.ts", import.meta.url), "utf8");
  const { text } = stampCatalogSource(source, [{
    rowId: "meta",
    checkedOn: "2026-10-01",
    docs: [{ id: "graph-version", state: "changed" }],
  }]);
  assert.notEqual(text, source);
  assert.ok(text.includes('checkedOn: "2026-10-01"'));
  assert.ok(text.includes('state: "changed"'));
  // The row's own verification stamp is untouched, by its exact date.
  assert.ok(text.includes('proof: "endpoint-answered"'));
  assert.equal(
    (text.match(/proof: "documented"/g) ?? []).length,
    (source.match(/proof: "documented"/g) ?? []).length,
  );
});

test("the feedback record is written where a feedback panel would look, and replaced each run", async () => {
  const dir = mkdtempSync(path.join(root, "feedback-"));
  const store = fakeStore();
  await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  const open = JSON.parse(store.getSetting(VERIFICATION_FEEDBACK_SETTING, "[]"));
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "marketplace-verification");
  assert.equal(open[0].target, "fixturevendor");
  assert.equal(open[0].state, "open");
  assert.match(open[0].title, /a fact this marketplace row depends on has moved/);

  // The vendor's page comes back. The complaint has to go with it, or the tracker rots.
  putFixture(dir, ROW.docs[0].url, PERMISSION_PAGE("pages_manage_posts"));
  await verifyCatalog({ plugins: [ROW], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  assert.deepEqual(JSON.parse(store.getSetting(VERIFICATION_FEEDBACK_SETTING, "[]")), []);
});

test("a run narrowed to one row does not close the complaints about the others", async () => {
  // `marketplace verify --row meta` is a normal thing to run while chasing one vendor, and a writer
  // that replaced the whole list would silently mark every other row's open complaint as gone.
  const dir = mkdtempSync(path.join(root, "narrow-"));
  const store = fakeStore();
  const second = { ...ROW, id: "othervendor", name: "Other Vendor" };
  await verifyCatalog({ plugins: [ROW, second], fetchDoc: fixtureFetcher(dir), store, source: "test" });
  assert.equal(JSON.parse(store.getSetting(VERIFICATION_FEEDBACK_SETTING, "[]")).length, 2);

  // One row comes back, checked on its own.
  putFixture(dir, ROW.docs[0].url, PERMISSION_PAGE("pages_manage_posts"));
  await verifyCatalog({ plugins: [ROW, second], only: "fixturevendor", fetchDoc: fixtureFetcher(dir), store, source: "test" });
  const open = JSON.parse(store.getSetting(VERIFICATION_FEEDBACK_SETTING, "[]"));
  assert.deepEqual(open.map((item) => item.target), ["othervendor"]);
});

test("the rows are read out of catalog.ts itself, and it is still a plain data literal", () => {
  const plugins = loadCatalogPlugins();
  assert.ok(plugins.length >= 20, `only ${plugins.length} rows came back`);
  const withDocs = rowsWithDocs(plugins).map((row) => row.id);
  for (const id of ["meta", "x", "linkedin", "buffer", "browserbase"]) {
    assert.ok(withDocs.includes(id), `${id} carries no doc facts`);
  }
  // The parse is exact rather than a regex, and it stays exact only while the literal stays data.
  assert.throws(() => readCatalogPlugins('const DECLARED_PLUGINS = [Object.freeze({ id: someName })];\n]);'), /no longer a plain data literal|does not end where/);
});

test("age is what a customer's page goes by between releases", () => {
  const [row] = rowsWithDocs(loadCatalogPlugins());
  const fresh = rowAge(row, Date.parse(`${row.docs[0].checkedOn}T12:00:00Z`));
  assert.equal(fresh.stale, false);
  const old = rowAge(row, Date.parse(`${row.docs[0].checkedOn}T12:00:00Z`) + (row.recheckDays + 3) * 24 * 60 * 60 * 1000);
  assert.equal(old.stale, true);
  assert.equal(old.recheckDays, row.recheckDays ?? DEFAULT_RECHECK_DAYS);
});

test("a table reduced from HTML keeps its cells apart", () => {
  // Buffer's plan table, which fuses into "FeatureFreeEssentialsTeam" when a tag is replaced by
  // nothing instead of a space, taking every number in it with it.
  const table = "<table><tr><th>Feature</th><th>Free</th><th>Essentials</th></tr><tr><td>30-day limit</td><td>3,000</td><td>7,500</td></tr></table>";
  const text = htmlToPlainText(table);
  assert.ok(text.includes("Feature Free Essentials"), text);
  assert.ok(text.includes("3,000"), text);
});

test("prose before a heading is left alone, so a real first paragraph is never eaten as navigation", () => {
  const page = "Skip to main content. Access to this page requires authorization.\n\n# Posts API\n\nbody";
  assert.ok(stripNavPrefix(page).startsWith("Skip to main content"));
  assert.equal(stripDocNoise("").length, 0);
  assert.equal(checkDoc({ ...ROW.docs[1] }, null).state, "not-published");
});
