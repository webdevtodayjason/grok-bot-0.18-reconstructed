// MARKET-26. When the plugin page tells a customer to hold off.
//
// The page decided that from AGE alone: is the oldest dated fact on this row older than the row's
// own recheck interval. That misses the case the recurring check exists for. The job reads the
// vendor's page, cannot find the fact the row depends on, marks that fact `changed` and stamps the
// read date FORWARD -- so the row is fresh by age and wrong in fact. Measured on the R750 on
// 2026-09-09: `marketplace list` printed browserbase as NEEDS RE-VERIFICATION while its page would
// have gone on saying "Checked 9 Sep 2026" for thirty days, with two credential boxes and an Add on
// it. The flip was already on the wire; it was only drawn one collapsed disclosure down.
//
// The gate (scripts/verify-marketplace.mjs) proves a person sees this in a real browser. This runs
// the console's own two functions, lifted out of app.js, over the four states they have to tell
// apart.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");

// The block is contiguous in app.js on purpose -- the date formatter, the age, the flag and the
// markup are one idea -- so it lifts out whole rather than function by function.
const start = source.indexOf("  const MONTHS = [");
const end = source.indexOf("  /** The steps that come BEFORE", start);
assert.ok(start > 0 && end > start, "the verification block moved; this test lifts it out by its landmarks");
const block = source.slice(start, end);
const load = new Function(
  "escapeHtml",
  `${block}\nreturn { marketplaceVerificationMarkup, marketplaceRowFlagged, marketplaceRowAge, marketplaceDay };`,
);
const { marketplaceVerificationMarkup, marketplaceRowFlagged, marketplaceRowAge } =
  load((value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const row = (docs, extra = {}) => ({
  id: "browserbase",
  source: { label: "docs.browserbase.com" },
  verification: { checkedOn: today, proof: "endpoint-answered", how: "x" },
  recheckDays: 30,
  docs,
  ...extra,
});

test("a row read today, with nothing changed, shows the date", () => {
  const html = marketplaceVerificationMarkup(row([{ id: "a", checkedOn: today, state: "verified" }]));
  assert.match(html, /data-marketplace-checked/);
  assert.ok(!/data-marketplace-under-review/.test(html));
});

test("a row nobody has read for longer than it asked is under review", () => {
  const html = marketplaceVerificationMarkup(row([{ id: "a", checkedOn: daysAgo(40), state: "verified" }]));
  assert.match(html, /data-marketplace-under-review/);
  assert.ok(!/data-marketplace-flagged/.test(html), "old is not the same as flagged, and the words differ");
  assert.ok(!/data-marketplace-checked/.test(html));
});

test("THE ONE THAT SHIPPED WRONG: a flagged row is under review even with today's date on it", () => {
  const item = row([
    { id: "session-auth", checkedOn: today, state: "changed" },
    { id: "proxies", checkedOn: today, state: "verified" },
  ]);
  assert.equal(marketplaceRowFlagged(item), true);
  assert.equal(marketplaceRowAge(item).stale, false, "by age this row is as fresh as it gets, which was the trap");
  const html = marketplaceVerificationMarkup(item);
  assert.match(html, /data-marketplace-flagged/);
  assert.match(html, /Under review/);
  assert.match(html, /[Hh]old off/, "and it says what to do, not only that something is wrong");
  assert.ok(!/data-marketplace-checked/.test(html), "a reassuring date must not sit beside the warning");
});

test("a vendor that publishes nothing to re-read is not a flag", () => {
  // LinkedIn's rate limits are the case: the vendor states it does not publish them, so there is
  // nothing to fetch and a weekly run must not flip the row every week over the absence.
  const item = row([{ id: "limits", checkedOn: today, state: "not-published", expected: "" }]);
  assert.equal(marketplaceRowFlagged(item), false);
  assert.match(marketplaceVerificationMarkup(item), /data-marketplace-checked/);
});

test("a row with no dated facts at all still says when it was last run", () => {
  const html = marketplaceVerificationMarkup(row([]));
  assert.match(html, /data-marketplace-verified/);
  assert.ok(!/data-marketplace-under-review/.test(html));
});
