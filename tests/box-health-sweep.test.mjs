// ADMIN-1. The relay's box-health sweep, and the budget it keeps.
//
// The sweep runs docker inspect, docker stats and du -sk for every customer, in sequence, and the
// control plane asks for the whole thing over HTTP and gives up after its own ceiling. Giving up
// there never stopped the work here, so before the budget one customer with a big directory could
// hold the report past that ceiling and take every other customer's row down with it, while the
// host carried on doing the work nobody was waiting for any more.
import assert from "node:assert/strict";
import test from "node:test";

import { SWEEP_BUDGET_MS, readBoxHealth, tenantDisk } from "../ui/box-health.mjs";

const entry = (slug) => ({
  slug, name: slug, box: `titanbot-box-${slug}`, gateway: "", token: "",
  stateDir: `/data/titanbot/${slug}/state`,
});

test("a slow customer takes the budget, and the ones after it are named rather than lost", async () => {
  // Every probe takes longer than the whole budget, so the first workspace uses it up.
  const exec = async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return { ok: true, out: "running" }; };
  const started = Date.now();
  const report = await readBoxHealth([entry("slow"), entry("second"), entry("third")], {
    exec,
    fetchImpl: async () => { throw new Error("no gateway in this test"); },
    budgetMs: 50,
  });
  const took = Date.now() - started;

  assert.equal(report.boxes.length, 3, "every workspace has a row, measured or not");
  assert.equal(report.boxes[0].containerState, "running", "the one the sweep reached was measured");
  assert.equal(report.sweptEveryWorkspace, false, "and the report says out loud that it was cut off");
  for (const row of report.boxes.slice(1)) {
    assert.equal(row.containerState, "not measured");
    assert.equal(row.diskKb, null);
    assert.match(row.containerStateWhy, /ran out of its .* budget/);
  }
  // The whole point: it comes back rather than running on for three times the budget.
  assert.ok(took < 400, `the sweep returned in ${took}ms`);
});

test("nothing is cut off when there is time, and the budget is the one number that decides", async () => {
  const exec = async () => ({ ok: true, out: "running" });
  const report = await readBoxHealth([entry("a"), entry("b")], {
    exec,
    fetchImpl: async () => ({ status: 200 }),
    budgetMs: SWEEP_BUDGET_MS,
  });
  assert.equal(report.sweptEveryWorkspace, true);
  assert.equal(report.budgetMs, SWEEP_BUDGET_MS);
  assert.equal(report.boxes.every((row) => row.containerState === "running"), true);
});

test("du is cut to what is left of the budget, not to its own twenty seconds", async () => {
  const asked = [];
  const exec = async (file, args, timeout) => { asked.push({ file, timeout }); return { ok: true, out: "1024\t/data" }; };
  await tenantDisk("/data/titanbot/acme", { exec, timeoutMs: 900 });
  assert.equal(asked[0].file, "du");
  assert.equal(asked[0].timeout, 900);

  // And a caller who asks for nothing still gets a real ceiling rather than none.
  asked.length = 0;
  await tenantDisk("/data/titanbot/acme", { exec, timeoutMs: 0 });
  assert.ok(asked[0].timeout >= 500, `a floor rather than no timeout at all: ${asked[0].timeout}`);
});
