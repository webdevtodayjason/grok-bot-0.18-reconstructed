// ONBOARD-4: the dated marker a removal leaves on a customer's files, and the hourly sweep.
//
// WHAT THIS SUITE IS GUARDING, and each rule has a case that would catch it going the other way:
//
//   - NOTHING WITHOUT A MARKER IS TOUCHED. A directory with no kept-until.json is a live customer's
//     tree or an orphan from a failed build (ONBOARD-6), and both want an operator rather than a
//     timer. The sweep is driven here with a clock years past every date and the unmarked directory
//     is still on the disk afterwards.
//   - THE DATE IN THE FILE IS WHAT THE SWEEP ACTS ON. Not a default recomputed in code, and not a
//     directory's mtime, which the first person to look at the tree would move.
//   - A MARKER IT CANNOT READ IS NEVER DUE. The alternative is a parse error that deletes a
//     customer's files.
//   - THE DELETION GOES THROUGH THE RELAY AND CARRIES THE CONTAINER NAME. ONBOARD-6 measured what
//     happens without it: POST /tenant/purge answers 409 container_unknown for a workspace its own
//     registry has forgotten, and after the Coolify service is gone there is nothing left to ask. So
//     the removal writes the name into the marker and the sweep carries it back.
//   - A REFUSAL LEAVES THE TREE WHERE IT IS AND SAYS SO. It is never retried into a loop and never
//     counted as a deletion.
//
// The purge door here is ui/purge-edge.mjs itself, through tests/purge-double.mjs, for the reason
// that file exists: two hand-written fakes of this contract once held a field-for-field disagreement
// in place across 78 green tests.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  KEPT_DAYS,
  KEPT_MARKER_NAME,
  createKeptSweep,
  keptMarkerFileIn,
  listKeptMarkers,
  readKeptMarker,
  sizeInWords,
  writeKeptMarker,
} from "../cp/kept.mjs";
import { createRelayAsk, loadConfig } from "../cp/provision.mjs";
import { makeTempRoot, startFakeRelay } from "./cp-support.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-09-13T02:00:00.000Z");

/**
 * A container name shaped the way Coolify really makes them.
 *
 * It matters that this has no dash after the prefix: ui/purge-edge.mjs BOX_CONTAINER_RE only accepts
 * `titanbot-box-` followed by lowercase letters and digits, so a name a test invented with a dash in
 * it is thrown away and the route answers 409 container_unknown. Measured on the R750 2026-09-07,
 * every Coolify resource uuid is lowercase alphanumeric, which is why that rule is safe and why a
 * fixture has to look like the real thing to prove anything.
 */
const BOX = "titanbot-box-p927bfqm83ioloibamlvyd7g";

/**
 * A tenant root with directories in it, a relay that will purge from it, and a clock a test moves by
 * hand.
 *
 * The clock is a variable and not a timer: every date this feature turns on is thirty days wide, and
 * a test that waited for one would be a test nobody runs.
 */
async function withWorld(run, options = {}) {
  const root = await makeTempRoot("cp-kept-");
  const tenantRoot = path.join(root, "tenants");
  mkdirSync(tenantRoot, { recursive: true });
  const relay = await startFakeRelay({ tenantRoot, ...(options.relay ?? {}) });
  const config = loadConfig({
    CP_DATA_DIR: path.join(root, "data"),
    CP_TENANT_ROOT: tenantRoot,
    CP_RELEASE_ROOT: path.join(root, "release"),
    CP_BASE_DOMAIN: "titanium.bot",
    CP_RELAY_URL: relay.url,
    CP_RELAY_TOKEN: relay.token,
  });
  let clock = START;
  const lines = [];
  const world = {
    root,
    tenantRoot,
    relay,
    config,
    lines,
    now: () => clock,
    advanceDays: (days) => { clock += Math.round(Number(days) * DAY_MS); },
    /** A customer's directory on the disk, with the size the relay will report for it. */
    tree(slug, { bytes = 6_200_000, files = ["volumes/data/settings.json"] } = {}) {
      const dir = path.join(tenantRoot, slug);
      for (const file of files) {
        mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        writeFileSync(path.join(dir, file), "{}");
      }
      mkdirSync(dir, { recursive: true });
      relay.data.set(slug, { path: dir, bytes });
      return dir;
    },
    sweepFor(extra = {}) {
      return createKeptSweep({
        config,
        askRelayPost: createRelayAsk({ config, timeoutMs: 4_000 }),
        now: () => clock,
        log: (line) => lines.push(line),
        ...extra,
      });
    },
  };
  try { await run(world); }
  finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ---- the marker ---------------------------------------------------------------------------------

test("the marker carries the day, the window and the container, and is 0600", async () => {
  await withWorld(async (world) => {
    const dir = world.tree("acme-roofing");
    const written = writeKeptMarker({
      dir, slug: "acme-roofing", container: BOX, reason: "the operator left the data switch off", at: world.now(),
    });
    assert.equal(written.ok, true, written.why);
    assert.equal(written.day, "2026-10-13", "thirty days from 2026-09-13");
    assert.equal(statSync(written.file).mode & 0o777, 0o600, "a marker is not a secret, but it is written the way this product writes files it owns");

    const parsed = JSON.parse(readFileSync(written.file, "utf8"));
    assert.equal(parsed.slug, "acme-roofing");
    assert.equal(parsed.days, KEPT_DAYS);
    assert.equal(parsed.container, BOX, "ONBOARD-6: without this the purge route cannot prove the container is gone");
    assert.equal(parsed.keptUntil, new Date(START + KEPT_DAYS * DAY_MS).toISOString());
    assert.equal(path.basename(written.file), KEPT_MARKER_NAME);
    assert.equal(keptMarkerFileIn(dir), written.file);
  });
});

test("a workspace with no directory gets no marker, and that is not a failure", async () => {
  await withWorld(async (world) => {
    const answer = writeKeptMarker({ dir: path.join(world.tenantRoot, "never-built"), slug: "never-built", at: world.now() });
    assert.equal(answer.ok, false);
    assert.equal(answer.nothingToKeep, true, "there is nothing to keep, which is different from a write that failed");
    assert.match(answer.why, /nothing at .* to keep/);
  });
});

// ---- the listing --------------------------------------------------------------------------------

test("only marked directories are listed, and an unreadable marker is listed as unreadable", async () => {
  await withWorld(async (world) => {
    world.tree("acme-roofing");
    writeKeptMarker({ dir: path.join(world.tenantRoot, "acme-roofing"), slug: "acme-roofing", container: BOX, at: world.now() });
    // A live customer. No marker, so it is not this mechanism's business.
    world.tree("north-bay");
    // A marker nothing can read, which must be listed and must never be due.
    const broken = world.tree("half-written");
    writeFileSync(keptMarkerFileIn(broken), "{ this is not json");

    const listed = listKeptMarkers({ tenantRoot: world.tenantRoot });
    assert.equal(listed.ok, true, listed.why);
    assert.deepEqual(listed.rows.map((row) => row.slug).sort(), ["acme-roofing", "half-written"]);
    const half = listed.rows.find((row) => row.slug === "half-written");
    assert.equal(half.readable, false);
    assert.equal(half.keptUntil, null);
    assert.match(half.why, /could not be read/);
    assert.equal(readKeptMarker(path.join(world.tenantRoot, "north-bay")).present, false, "a directory with no marker is not half a row");
  });
});

test("the panel's list carries the date, the days left and the size in words", async () => {
  await withWorld(async (world) => {
    world.tree("acme-roofing", { bytes: 6_200_000 });
    writeKeptMarker({ dir: path.join(world.tenantRoot, "acme-roofing"), slug: "acme-roofing", container: BOX, at: world.now() });
    const sweep = world.sweepFor();
    world.advanceDays(10);
    const answer = await sweep.list();
    assert.equal(answer.ok, true, answer.why);
    assert.equal(answer.rows.length, 1);
    const [row] = answer.rows;
    assert.equal(row.day, "2026-10-13");
    assert.equal(row.daysLeft, 20);
    assert.equal(row.pastDue, false);
    assert.equal(row.bytes, 6_200_000);
    assert.equal(row.size, "5.9 MB", "the size is in words, with the same rounding the box table uses");
    assert.equal(row.size, sizeInWords(6_200_000));
    assert.equal(row.container, BOX);
  });
});

test("a size the relay will not give is named and never drawn as a zero", async () => {
  await withWorld(async (world) => {
    world.tree("acme-roofing");
    writeKeptMarker({ dir: path.join(world.tenantRoot, "acme-roofing"), slug: "acme-roofing", at: world.now() });
    // No relay configured at all, which is what an install with CP_RELAY_URL unset looks like.
    const blind = createKeptSweep({
      config: { ...world.config, relayUrl: "", relayToken: "" },
      askRelayPost: createRelayAsk({ config: { relayUrl: "", relayToken: "" } }),
      now: world.now,
    });
    const answer = await blind.list();
    assert.equal(answer.rows.length, 1);
    assert.equal(answer.rows[0].bytes, null, "a zero here is indistinguishable from an empty directory");
    assert.equal(answer.rows[0].size, null);
    assert.match(answer.rows[0].sizeWhy, /no relay configured/);
    assert.equal(answer.rows[0].day, "2026-10-13", "the date is local and is readable with no relay at all");
  });
});

// ---- the sweep ----------------------------------------------------------------------------------

test("the sweep deletes a directory once its date has passed and logs the size that came back", async () => {
  await withWorld(async (world) => {
    const dir = world.tree("acme-roofing", { bytes: 6_200_000 });
    writeKeptMarker({ dir, slug: "acme-roofing", container: BOX, at: world.now() });
    const sweep = world.sweepFor();

    // Twenty-nine days in: nothing happens, and it says so.
    world.advanceDays(29);
    const early = await sweep.sweep();
    assert.deepEqual(early.deleted, []);
    assert.equal(existsSync(dir), true);
    assert.match(world.lines.at(-1), /1 directory kept, none past its date/);

    // Thirty-one: gone, with one line carrying the size.
    world.advanceDays(2);
    const late = await sweep.sweep();
    assert.equal(late.deleted.length, 1, JSON.stringify(late.refused));
    assert.equal(late.deleted[0].slug, "acme-roofing");
    assert.equal(late.deleted[0].bytes, 6_200_000);
    assert.equal(late.bytesFreed, 6_200_000);
    assert.equal(existsSync(dir), false, "the relay deletes the tree, because the control plane cannot read inside it");
    assert.match(world.lines.at(-1), /^kept data: acme-roofing deleted, 5\.9 MB freed \(kept from 2026-09-13 until 2026-10-13\)$/);

    // THE CONTAINER NAME TRAVELLED. Without it the route answers 409 container_unknown and the tree
    // is undeletable for ever, which is the condition ONBOARD-6 measured on north-bay-roofing.
    const purges = world.relay.callsTo("/tenant/purge").filter((call) => call.body?.probeOnly !== true);
    assert.equal(purges.at(-1).body.container, BOX);
    assert.equal(purges.at(-1).body.confirm, "acme-roofing", "the route refuses a body without it, so a sweep that forgot it would delete nothing for ever");

    // And the row is gone from the listing, because the marker went with the tree.
    const after = await sweep.list();
    assert.deepEqual(after.rows, []);
  });
});

test("a directory with no marker survives a sweep run years past every date", async () => {
  await withWorld(async (world) => {
    const live = world.tree("north-bay");
    const orphan = world.tree("onboard-test-f7f435");
    const sweep = world.sweepFor();
    world.advanceDays(4000);
    const answer = await sweep.sweep();
    assert.deepEqual(answer.deleted, []);
    assert.deepEqual(answer.kept, []);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(orphan), true, "an orphan from a failed build wants an operator looking at it, not a timer");
    assert.equal(world.relay.callsTo("/tenant/purge").length, 0, "nothing was even asked about");
  });
});

test("a marker with no readable date is never due, however long the clock runs", async () => {
  await withWorld(async (world) => {
    const dir = world.tree("half-written");
    writeFileSync(keptMarkerFileIn(dir), JSON.stringify({ slug: "half-written", removedAt: "2026-09-13T00:00:00.000Z" }));
    const sweep = world.sweepFor();
    world.advanceDays(4000);
    const answer = await sweep.sweep();
    assert.deepEqual(answer.deleted, []);
    assert.equal(answer.kept.length, 1);
    assert.equal(answer.kept[0].readable, false);
    assert.match(answer.kept[0].why, /no readable keptUntil/);
    assert.equal(existsSync(dir), true);
  });
});

test("a relay that refuses leaves the tree where it is, logs why, and counts no deletion", async () => {
  await withWorld(async (world) => {
    const dir = world.tree("acme-roofing");
    writeKeptMarker({ dir, slug: "acme-roofing", container: BOX, at: world.now() });
    const sweep = world.sweepFor();
    world.relay.state.purgeRefusal = "That workspace's computer is still there, so its data was left alone.";
    world.advanceDays(31);
    const answer = await sweep.sweep();
    assert.deepEqual(answer.deleted, []);
    assert.equal(answer.refused.length, 1);
    assert.equal(answer.refused[0].slug, "acme-roofing");
    assert.match(answer.refused[0].why, /still there/);
    assert.equal(existsSync(dir), true);
    assert.match(world.lines.at(-1), /^kept data: acme-roofing was due on 2026-10-13 and was NOT deleted: /);

    // And the next pass tries again, because a refusal is not a decision.
    world.relay.state.purgeRefusal = null;
    const again = await sweep.sweep();
    assert.equal(again.deleted.length, 1);
    assert.equal(existsSync(dir), false);
  });
});

test("a window the caller chose is the window the marker and the sweep use", async () => {
  await withWorld(async (world) => {
    const dir = world.tree("acme-roofing");
    const written = writeKeptMarker({ dir, slug: "acme-roofing", container: BOX, at: world.now(), days: 7 });
    assert.equal(written.day, "2026-09-20");
    const sweep = world.sweepFor();
    world.advanceDays(8);
    const answer = await sweep.sweep();
    assert.equal(answer.deleted.length, 1, "the date in the file is what the sweep acts on, never the default in the code");
    assert.equal(existsSync(dir), false);
  });
});
