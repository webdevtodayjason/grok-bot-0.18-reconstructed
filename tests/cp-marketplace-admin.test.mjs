// MARKET-26 / CLOUD-BROWSER-1. The control plane's marketplace routes and the console's seventh
// panel, against a real control plane on an ephemeral port.
//
// The claims:
//
//  1. The two operator routes answer, and neither opens to anything but the operator bearer.
//  2. The seventh panel exists and the page says so: `__adminLive.panels` is what a browser gate
//     waits on, and a panel added to the HTML but not to the loader would leave that number saying
//     six while the screen showed seven.
//  3. The ledger view prints "not reported by this vendor" rather than 0 for a null proxyBytes.
//     That is the whole reason the number is nullable: browser time is cents an hour and the
//     residential proxy is dollars a gigabyte, so a zero in that column hides the larger number.
//  4. A row flipped in the settings table reads as needing re-verification on the panel, which is
//     the operator-facing half of the two-tier delivery.
//  5. The run route spends nothing and says so.
import assert from "node:assert/strict";
import test from "node:test";

import { startControlPlane } from "./cp-support.mjs";
import { VERIFICATION_RUN_SETTING, VERIFICATION_SETTING_PREFIX } from "../cp/verification.mjs";

/**
 * A relay that answers the cloud-browser ledger route with rows in the written contract's shape.
 *
 * ONE ROUTE PER TENANT -- /admin/tenants/<slug>/cloud-browser -- because that is what the relay
 * serves: the ledger is a file inside that tenant's own container and a container is what a slug
 * resolves to. It also stamps the slug it resolved by over whatever the box called itself, so this
 * fake answers rows for the slug in the path and the panel's grouping is measured against that.
 */
async function startFakeRelay(rows, { status = 200 } = {}) {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: String(request.headers.authorization ?? "") });
    if (status !== 200) { response.writeHead(status); response.end("{}"); return; }
    const slug = /^\/admin\/tenants\/([^/]+)\/cloud-browser$/.exec(new URL(request.url, "http://relay.invalid").pathname)?.[1] ?? "";
    const body = JSON.stringify({ slug, read: true, why: "", rows: rows.filter((row) => row.tenant === slug) });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

// The written contract for /home/box/sand-data/cloud-browser-ledger.jsonl, one object per line.
// `proxyBytes` is null on the vendor that publishes no per-session traffic figure.
const LEDGER_ROWS = [
  { tenant: "demo", agentId: "agent-1", vendor: "browserbase", sessionId: "s1", startedAt: "2026-09-09T10:00:00Z", endedAt: "2026-09-09T10:04:00Z", minutes: 4, proxyBytes: 10_485_760, engine: "browserbase", reason: "site on the workspace's cloud list", url: "https://example.invalid/signup" },
  { tenant: "demo", agentId: "agent-1", vendor: "browser-use", sessionId: "s2", startedAt: "2026-09-09T10:20:00Z", endedAt: "2026-09-09T10:26:00Z", minutes: 6, proxyBytes: null, engine: "browser-use", reason: "the in-box engine came back empty", url: "https://example.invalid/profile" },
];

async function withPlane(run, { relay = null } = {}) {
  const plane = await startControlPlane({
    env: {
      // The job is off in tests: it would reach seven vendors over the internet at boot.
      CP_MARKETPLACE_VERIFY: "0",
      ...(relay ? { CP_RELAY_URL: relay.url, CP_RELAY_TOKEN: "relay-token-for-a-test-0123456789" } : {}),
    },
  });
  try { await run(plane); } finally { await plane.dispose(); }
}

test("the two marketplace routes answer only to the operator bearer", async () => {
  await withPlane(async (plane) => {
    const nobody = await plane.request("GET", "/v1/marketplace/verification");
    assert.equal(nobody.status, 401);

    const answer = await plane.admin("GET", "/v1/marketplace/verification");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.catalogProblem, null, String(answer.body.catalogProblem));
    // The rows are read out of catalog.ts itself, so this is also the assertion that the control
    // plane can still parse the catalog after somebody edits it.
    const ids = answer.body.catalog.map((row) => row.id);
    for (const id of ["meta", "x", "linkedin", "buffer", "browserbase"]) assert.ok(ids.includes(id), id);
    assert.equal(answer.body.meteredRuns, 0);
    assert.ok(answer.body.ignores.length > 0, "the panel does not say what it ignores as boilerplate");

    const wrongMethod = await plane.admin("DELETE", "/v1/marketplace/verification");
    assert.equal(wrongMethod.status, 405);
  });
});

// This column used to be computed from AGE ALONE, which made it its own lie: a `--write` moves the
// read date forward on a fact it could not confirm, so the panel printed "checked today" beside a
// row the same screen was calling NEEDS RE-VERIFICATION. Measured on the R750 on 2026-09-09 against
// browserbase. It now decides the way the customer's page decides -- the row's own verdict first,
// its age second -- and says which of the two kinds of under review it is.
test("what the customer sees names the row's own verdict first, and its age second", async () => {
  await withPlane(async (plane) => {
    const answer = await plane.admin("GET", "/v1/marketplace/verification");
    for (const row of answer.body.catalog) {
      assert.match(
        row.customerSees,
        /^(checked \d{4}-\d{2}-\d{2}|under review \((a fact on it changed|nobody has re-read it)\))$/,
        `${row.id}: ${row.customerSees}`,
      );
      assert.ok(Number.isInteger(row.recheckDays) && row.recheckDays > 0, row.id);
      assert.match(row.oldestCheckedOn, /^\d{4}-\d{2}-\d{2}$/, row.id);
      // The one that was wrong: a row carrying a changed fact may never read as a reassuring date,
      // however fresh that date is.
      const flagged = (row.docs ?? []).some((doc) => doc.state === "changed");
      if (flagged) {
        assert.equal(row.customerSees, "under review (a fact on it changed)", row.id);
      }
    }
    // And the shipped catalog has to still carry the case, or this test guards nothing.
    assert.ok(
      answer.body.catalog.some((row) => (row.docs ?? []).some((doc) => doc.state === "changed")),
      "no row in the shipped catalog carries a changed fact, so the branch above was never taken",
    );
  });
});

test("a row flipped in the settings table reads as needing re-verification on the panel", async () => {
  await withPlane(async (plane) => {
    plane.store.setSetting(`${VERIFICATION_SETTING_PREFIX}meta`, JSON.stringify({
      rowId: "meta",
      name: "Meta: Facebook Pages and Instagram",
      state: "needs-re-verification",
      checkedOn: "2026-09-09",
      checkedAt: "2026-09-09T09:00:00.000Z",
      docs: [],
      changed: [{
        docId: "graph-version",
        what: "The current Graph API version",
        url: "https://developers.facebook.com/docs/graph-api/changelog",
        expected: "v26.0",
        found: "The latest Graph API version is: v27.0",
        reason: "the anchor is still there and no longer says it",
      }],
      unreadable: [],
    }), "a test");
    plane.store.setSetting(VERIFICATION_RUN_SETTING, JSON.stringify({
      ranAt: "2026-09-09T09:00:00.000Z", source: "test", rows: ["meta"], verified: [], needsReVerification: ["meta"], notMeasured: [], meteredRuns: 0,
    }), "a test");

    const answer = await plane.admin("GET", "/v1/admin/marketplace");
    assert.equal(answer.status, 200);
    const record = answer.body.records.find((row) => row.rowId === "meta");
    assert.equal(record.state, "needs-re-verification");
    // Both sides, so the operator does not have to open the vendor's page to learn what moved.
    assert.equal(record.changed[0].expected, "v26.0");
    assert.match(record.changed[0].found, /v27\.0/);
    assert.deepEqual(answer.body.rollup.needsReVerification, ["meta"]);
  });
});

test("the ledger says 'not reported by this vendor' rather than a zero, and never sums a null", async () => {
  const relay = await startFakeRelay(LEDGER_ROWS);
  try {
    await withPlane(async (plane) => {
      // The panel asks per tenant, so a tenant has to exist for there to be anything to ask about.
      plane.store.createTenant({ slug: "demo", name: "Demo", status: "running" });
      const answer = await plane.admin("GET", "/v1/admin/marketplace");
      assert.equal(answer.status, 200);
      const ledger = answer.body.ledger;
      assert.equal(ledger.measured, true, ledger.why);
      assert.equal(ledger.rows.length, 2);

      // The null is carried through as a null. Coerced to a number anywhere on the way, this column
      // would read as free for the vendor that actually costs the most.
      const unreported = ledger.rows.find((row) => row.vendor === "browser-use");
      assert.equal(unreported.proxyBytes, null);
      assert.equal(unreported.minutes, 6);

      const [tenant] = ledger.tenants;
      assert.equal(tenant.tenant, "demo");
      assert.equal(tenant.sessions, 2);
      assert.equal(tenant.minutes, 10);
      assert.equal(tenant.proxyBytes, 10_485_760, "a null was summed as a zero");
      assert.deepEqual(tenant.proxyUnreportedBy, ["browser-use"]);
      assert.deepEqual(tenant.proxyReportedBy, ["browserbase"]);
      assert.match(ledger.note, /missing rather than zero/);

      // And the panel's own words carry the sentence, so a browser reading the page sees it.
      const page = await plane.request("GET", "/admin/admin.js");
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("not reported by this vendor"), "the console has no words for an unreported figure");
      assert.ok(!/proxyBytes\s*\)\s*\|\|\s*0/.test(page.text), "the console coerces a missing figure to zero");
      // A PARTIAL total says so on the screen, not only in a tooltip. `demo` above ran two sessions
      // and only one vendor reports traffic, so a bare "10 MB" is a number an operator would read
      // as the whole bill and budget against. Measured in a real browser on 2026-09-09: the cell
      // reads "10 MB" with "plus browser-use, not reported" under it.
      assert.ok(page.text.includes("not reported`"), "a partial proxy total does not say so on screen");
    }, { relay });
  } finally { await relay.close(); }
});

test("a relay with no ledger route yet is 'not measured' and says why, and is never a zero", async () => {
  const relay = await startFakeRelay([], { status: 404 });
  try {
    await withPlane(async (plane) => {
      plane.store.createTenant({ slug: "demo", name: "Demo", status: "running" });
      const answer = await plane.admin("GET", "/v1/admin/marketplace");
      const ledger = answer.body.ledger;
      assert.equal(ledger.measured, false);
      assert.match(ledger.why, /answered 404/);
      assert.deepEqual(ledger.rows, []);
      assert.deepEqual(ledger.tenants, []);
      // Named, not counted: an operator has to be able to see WHICH workspace is missing from a
      // total, or a partial answer reads as a whole one.
      assert.deepEqual(ledger.unread.map((row) => row.tenant), ["demo"]);
    }, { relay });
  } finally { await relay.close(); }
});

test("the console has a seventh panel and says so, and its CSS came with it", async () => {
  await withPlane(async (plane) => {
    const page = await plane.request("GET", "/admin");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('data-panel="marketplace"'), "the marketplace panel is not on the page");
    assert.ok(page.text.includes('id="marketplaceRows"'));
    assert.ok(page.text.includes('id="marketplaceLedger"'));

    const script = await plane.request("GET", "/admin/admin.js");
    // The flag a browser gate waits on. A panel added to the HTML and not to the loader would leave
    // the flag saying one number while the screen showed another, and the gate would pass on a
    // blank table. So this asserts the INVARIANT rather than a literal: the flag equals the number
    // of panel loaders the refresh actually runs. Three waves added panels to this file on the same
    // day and a pinned "7" would have gone red for the wave that merged second, which is not a
    // defect, it is a wave doing its job.
    const declared = /window\.__adminLive = \{ panels: (\d+)/.exec(script.text);
    assert.ok(declared != null, "the live flag is gone from admin.js");
    const loaders = /Promise\.allSettled\(\[([^\]]*)\]\)/.exec(script.text);
    assert.ok(loaders != null, "the refresh no longer loads its panels together");
    assert.equal(Number(declared[1]), loaders[1].split(",").filter((call) => call.trim().length > 0).length,
      "the live flag counts a different number of panels than the refresh loads");
    assert.ok(script.text.includes("loadMarketplace()"), "the seventh panel is not loaded with the others");
    assert.ok(script.text.includes('api("GET", "/v1/admin/marketplace")'));

    const css = await plane.request("GET", "/admin/admin.css");
    assert.equal(css.status, 200);
    assert.ok(css.text.includes("#marketplaceLedger"), "the ledger column has no styling of its own");
  });
});

test("the run route reports what it spent, which is nothing", async () => {
  await withPlane(async (plane) => {
    // A row that fetches nothing, so this test makes no outbound request: `--row` narrows the run to
    // one id, and an id that is not in the catalog narrows it to none.
    const answer = await plane.admin("POST", "/v1/marketplace/verification/run", { row: "not-a-catalog-row" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.meteredRuns, 0);
    assert.deepEqual(answer.body.rows, []);
    assert.match(answer.body.ranOn, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("no marketplace route hands back the operator token, the session secret or a password hash", async () => {
  await withPlane(async (plane) => {
    const bodies = [];
    for (const [method, pathname] of [["GET", "/v1/marketplace/verification"], ["GET", "/v1/admin/marketplace"]]) {
      const answer = await plane.admin(method, pathname);
      bodies.push(answer.text);
    }
    const blob = bodies.join("\n");
    assert.ok(!blob.includes(plane.config.adminToken));
    assert.ok(!blob.includes(plane.config.sessionSecret));
    assert.ok(!/"passwordHash"/.test(blob));
  });
});
