// ADMIN-1. The relay's box-health sweep, and the budget it keeps.
//
// The sweep runs docker inspect, docker stats and du -sk for every customer, in sequence, and the
// control plane asks for the whole thing over HTTP and gives up after its own ceiling. Giving up
// there never stopped the work here, so before the budget one customer with a big directory could
// hold the report past that ceiling and take every other customer's row down with it, while the
// host carried on doing the work nobody was waiting for any more.
import assert from "node:assert/strict";
import test from "node:test";

import { SWEEP_BUDGET_MS, createBoxHealthSweeper, readBoxHealth, tenantDisk } from "../ui/box-health.mjs";

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

test("the background sweep lets fast workspaces finish while a slow one is still running", async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const finished = [];
  const read = async ([one]) => {
    if (one.slug === "slow") await slow;
    finished.push(one.slug);
    return { boxes: [{ ...one, containerState: "running", measuredAt: "2026-09-12T12:00:00.000Z" }] };
  };
  const sweep = createBoxHealthSweeper({
    entries: [entry("slow"), entry("fast-a"), entry("fast-b")], read, intervalMs: 0,
  });

  const pending = sweep.sweep();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finished.sort(), ["fast-a", "fast-b"], "the slow slot did not hold the other slots");
  assert.deepEqual(sweep.read().boxes.filter((row) => row.measuredAt != null).map((row) => row.slug).sort(), ["fast-a", "fast-b"]);
  releaseSlow();
  await pending;
  assert.equal(sweep.read().boxes.every((row) => row.containerState === "running"), true);
});

test("the background sweep never probes more than four workspaces at once", async () => {
  let active = 0;
  let mostActive = 0;
  const releases = [];
  const read = async ([one]) => {
    active += 1;
    mostActive = Math.max(mostActive, active);
    await new Promise((resolve) => { releases.push(resolve); });
    active -= 1;
    return { boxes: [{ ...one, containerState: "running", measuredAt: "2026-09-12T12:00:00.000Z" }] };
  };
  const sweep = createBoxHealthSweeper({
    entries: Array.from({ length: 7 }, (_, index) => entry(`box-${index}`)), read, intervalMs: 0,
  });

  const pending = sweep.sweep();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mostActive, 4);
  while (releases.length > 0) {
    releases.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pending;
  assert.equal(mostActive, 4);
});

test("a workspace that exceeds its own budget releases a slot for the next workspace", async () => {
  const started = [];
  const read = async ([one], { signal }) => {
    started.push(one.slug);
    if (one.slug !== "box-4") return await new Promise(() => {});
    assert.equal(signal.aborted, false);
    return { boxes: [{ ...one, containerState: "running", measuredAt: new Date().toISOString() }] };
  };
  const sweep = createBoxHealthSweeper({
    entries: Array.from({ length: 5 }, (_, index) => entry(`box-${index}`)),
    read,
    budgetMs: 15,
    intervalMs: 0,
  });

  await sweep.sweep();
  assert.deepEqual(started, ["box-0", "box-1", "box-2", "box-3", "box-4"]);
  const report = sweep.read();
  assert.match(report.boxes[0].containerStateWhy, /exceeded its .* health budget/);
  assert.equal(report.boxes[4].containerState, "running");
});

test("a first read returns not measured rows immediately and starts exactly one sweep", async () => {
  let release;
  let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const read = async ([one]) => {
    calls += 1;
    await held;
    return { boxes: [{ ...one, containerState: "running", measuredAt: "2026-09-12T12:00:00.000Z" }] };
  };
  const sweep = createBoxHealthSweeper({ entries: [entry("first")], read, intervalMs: 0 });

  const first = sweep.read();
  assert.equal(calls, 1, "the read started the sweep before returning");
  assert.equal(first.boxes[0].containerState, "not measured");
  assert.equal(first.boxes[0].containerStateWhy, "not measured yet");
  assert.equal(first.boxes[0].measuredAt, null);
  assert.equal(first.boxes[0].ageMs, null);
  sweep.read();
  assert.equal(calls, 1, "another read joined the sweep instead of starting another one");

  release();
  await sweep.sweep();
  assert.equal(sweep.read().boxes[0].containerState, "running");
});

test("reports carry row ages and name stale measurements without hiding the probe reason", async () => {
  const measured = Date.parse("2026-09-12T12:00:00.000Z");
  let clock = measured;
  const read = async ([one]) => ({
    boxes: [{ ...one, containerState: "running", containerStateWhy: "docker was terse", measuredAt: new Date(clock).toISOString() }],
  });
  const sweep = createBoxHealthSweeper({ entries: [entry("aged")], read, now: () => clock, intervalMs: 0 });
  await sweep.sweep();

  clock += 120_000;
  const row = sweep.read().boxes[0];
  assert.equal(row.ageMs, 120_000);
  assert.match(row.containerStateWhy, /docker was terse; last measured 2 minutes ago/);
});

test("disk measurement stays off the sweep path and its last value is reused", async () => {
  let finishDisk;
  let finishNextDisk;
  let diskCalls = 0;
  const diskHeld = new Promise((resolve) => { finishDisk = resolve; });
  const nextDiskHeld = new Promise((resolve) => { finishNextDisk = resolve; });
  const exec = async (file) => {
    if (file === "du") {
      diskCalls += 1;
      if (diskCalls === 1) return diskHeld;
      if (diskCalls === 2) return nextDiskHeld;
      return { ok: true, out: "3072\t/data" };
    }
    if (file === "docker") return { ok: true, out: "running" };
    return { ok: false, why: "not used" };
  };
  const sweep = createBoxHealthSweeper({
    entries: [entry("disk")], exec,
    fetchImpl: async () => { throw new Error("no gateway in this test"); },
    intervalMs: 0,
  });

  await sweep.sweep();
  assert.equal(diskCalls, 1);
  assert.equal(sweep.read().boxes[0].diskKb, null, "the unfinished du did not hold the sweep open");
  await sweep.sweep();
  assert.equal(diskCalls, 1, "a running du was reused instead of duplicated");

  finishDisk({ ok: true, out: "2048\t/data" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweep.read().boxes[0].diskKb, 2048, "a completed du is published without waiting for another sweep");
  await sweep.sweep();
  assert.equal(sweep.read().boxes[0].diskKb, 2048, "the completed value stayed visible during the next du");
  finishNextDisk({ ok: true, out: "3072\t/data" });
});

test("the recurring timer runs every thirty seconds and can be stopped", async () => {
  let tick;
  let interval;
  let cleared = null;
  let calls = 0;
  const timer = { unref() {} };
  const sweep = createBoxHealthSweeper({
    entries: [entry("timer")],
    read: async ([one]) => {
      calls += 1;
      return { boxes: [{ ...one, containerState: "running", measuredAt: new Date().toISOString() }] };
    },
    setIntervalImpl: (callback, ms) => { tick = callback; interval = ms; return timer; },
    clearIntervalImpl: (value) => { cleared = value; },
  });

  assert.equal(interval, 30_000);
  await sweep.sweep();
  tick();
  await sweep.sweep();
  assert.equal(calls, 2);
  sweep.stop();
  assert.equal(cleared, timer);
});
