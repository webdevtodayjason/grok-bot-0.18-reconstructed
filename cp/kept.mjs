// cp/kept.mjs -- the dated marker a removal leaves on a customer's files, and the sweep that honours it.
//
// ONBOARD-4. What was true until this file existed, in the words of cp/decommission.mjs's own header:
// "THE DATA IS NOT ON A TIMER. With the switch off the card says what is true: the tree is kept and
// nothing deletes it. There is no reaper in this product, nothing counts days." That was honest and
// it was also a leak. Kept data is real disk on the R750 (/data, 2.6 T with 1.9 T free on
// 2026-09-10) and it grew one removed customer at a time with nothing watching it, so the only way
// it ever came back was somebody remembering a name and typing rm on a live server.
//
// THE THREE RULES THIS FILE IS, and each one is a refusal to guess:
//
//   1. NOTHING IS DELETED THAT HAS NO MARKER. The sweep reads directories under the tenant root and
//      acts only on the ones carrying kept-until.json, which only a removal writes. An orphan
//      directory from a failed build (ONBOARD-6) has no marker, so this never touches it: that
//      condition wants an operator looking at it, not a timer.
//   2. THE DATE IS IN THE FILE, not in this code. A sweep that recomputed "thirty days" from a
//      directory's mtime would delete a tree on the wrong day the first time anybody touched it, and
//      would have no answer at all for a tree whose mtime is older than its removal.
//   3. THE RELAY DOES THE DELETING AND THE MEASURING. Measured from inside titanbot-cp on the R750
//      2026-09-10: this service runs as uid 1001, a box's volumes/{data,workspace,chrome} are 0700
//      owned by uid 1000, and both ls and touch answer Permission denied. It cannot read the size of
//      what it is keeping and it cannot remove it. It CAN write and read the marker, because the
//      tenant's own root directory is one this service made. So the marker is local and every fact
//      about the bytes comes from POST /tenant/purge, the same route the removal's data step uses,
//      with probeOnly for the reading.
//
// WHAT THE MARKER CARRIES AND WHY EACH FIELD IS THERE: the slug, so a row can be named without
// trusting the directory's name; removedAt and keptUntil as ISO instants, so the date an operator
// reads is the date the sweep acts on; days, so a panel can say what the window was rather than
// assume today's default; container, because ONBOARD-6 measured the thing that makes a tree
// undeletable -- the relay's registry has forgotten a removed workspace, so POST /tenant/purge
// answers 409 container_unknown unless the caller carries the name, and after the Coolify service is
// gone there is nowhere left to look it up. The removal knows it, so the removal writes it down.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The marker's name, in one place, because the writer and the sweep are in different files. */
export const KEPT_MARKER_NAME = "kept-until.json";

/**
 * How long a removed customer's files are kept.
 *
 * Thirty days, which is the number the Remove card promised before anything counted it. It is a
 * default and not a law: the marker carries the window it was written with, so changing this never
 * moves a date somebody has already been told.
 */
export const KEPT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Once an hour. A window measured in days does not need a faster clock than that. */
export const KEPT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How stale a size may be before the panel asks the relay for it again.
 *
 * Every measurement is a walk of a customer's whole tree on the host, so this is not a number to
 * make small: the Box health panel loads on a click and a size that is fifteen minutes old is a
 * better answer than a page that waits on a du of twenty directories.
 */
export const KEPT_MEASURE_TTL_MS = 15 * 60 * 1000;

/** How many kept directories one pass will look at, so a tenant root nobody has swept cannot hang a page. */
export const KEPT_LIST_CAP = 200;

/** Where the marker is, inside one tenant's own directory. */
export const keptMarkerFileIn = (dir) => path.join(String(dir ?? ""), KEPT_MARKER_NAME);

/** The date a person reads, off an instant. Plain ISO, because a sweep acts on it and a date nobody can parse is a date nobody can check. */
export const keptDay = (ms) => {
  const at = Number(ms);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "";
};

/**
 * A size in words, which is what the panel prints.
 *
 * The same steps and the same rounding cp/admin/admin.js uses for a box's disk, on purpose: two
 * formatters for bytes in one console is how 6.2 MB and 6 MB end up on the same screen for the same
 * directory. Not measured is a SENTENCE somewhere else and never a zero here, so this answers null
 * for anything that is not a number.
 */
export function sizeInWords(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/**
 * Writing the marker. Called by the removal, once, in the step that decides to keep the files.
 *
 * It REFUSES on a directory that is not there rather than making one: a marker in an empty directory
 * this service created on the way past would have the sweep deleting a tree nobody ever had, and the
 * honest answer for a customer with no files is that there is nothing to keep.
 */
export function writeKeptMarker({
  dir,
  slug,
  container = "",
  reason = "",
  at = Date.now(),
  days = KEPT_DAYS,
  existsImpl = existsSync,
  writeImpl = writeFileSync,
  mkdirImpl = mkdirSync,
} = {}) {
  const directory = String(dir ?? "");
  const name = String(slug ?? "");
  const window = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : KEPT_DAYS;
  const removedAt = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const keptUntil = removedAt + window * DAY_MS;
  if (directory.length === 0 || name.length === 0) {
    return { ok: false, why: "a marker needs a workspace name and a directory, so none was written" };
  }
  if (!existsImpl(directory)) {
    return { ok: false, why: `there is nothing at ${directory} to keep, so no marker was written`, nothingToKeep: true };
  }
  const marker = {
    slug: name,
    // Written so a person reading the file on the server sees what it is for without this file open.
    what: "this directory belongs to a workspace that was removed, and this service deletes it on keptUntil",
    removedAt: new Date(removedAt).toISOString(),
    keptUntil: new Date(keptUntil).toISOString(),
    days: window,
    container: String(container ?? ""),
    reason: String(reason ?? ""),
  };
  const file = keptMarkerFileIn(directory);
  try {
    mkdirImpl(directory, { recursive: true });
    writeImpl(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return { ok: false, why: `the marker at ${file} could not be written (${String(error?.message ?? error).split("\n")[0]})` };
  }
  return { ok: true, file, removedAt, keptUntil, days: window, day: keptDay(keptUntil), marker };
}

/**
 * Reading one, and saying which way it is unreadable.
 *
 * A marker with no keptUntil in it is NOT treated as due. Anything this cannot read is listed with
 * the reason and left alone for ever, because the alternative is a parse error that deletes a
 * customer's files.
 */
export function readKeptMarker(dir, { readImpl = readFileSync } = {}) {
  const file = keptMarkerFileIn(dir);
  let parsed;
  try { parsed = JSON.parse(readImpl(file, "utf8")); }
  catch (error) {
    const missing = error?.code === "ENOENT";
    return { ok: false, present: !missing, file, why: missing ? "" : `the marker at ${file} could not be read (${String(error?.message ?? error).split("\n")[0]})` };
  }
  const keptUntil = Date.parse(String(parsed?.keptUntil ?? ""));
  if (!Number.isFinite(keptUntil)) {
    return { ok: false, present: true, file, why: `the marker at ${file} has no readable keptUntil, so nothing will delete this directory` };
  }
  const removedAt = Date.parse(String(parsed?.removedAt ?? ""));
  return {
    ok: true,
    present: true,
    file,
    slug: String(parsed?.slug ?? ""),
    keptUntil,
    removedAt: Number.isFinite(removedAt) ? removedAt : null,
    days: Number.isFinite(Number(parsed?.days)) ? Number(parsed.days) : null,
    container: String(parsed?.container ?? ""),
    reason: String(parsed?.reason ?? ""),
    why: "",
  };
}

/**
 * Every directory under the tenant root that a removal marked, and nothing else.
 *
 * The LISTING IS OF THE DISK and not of the ledger, which is the only way it can work: the tenant row
 * went with the removal, so a loop over tenants would find none of these. That is also why it reads a
 * marker rather than believing a directory name.
 */
export function listKeptMarkers({
  tenantRoot,
  cap = KEPT_LIST_CAP,
  readdirImpl = readdirSync,
  statImpl = statSync,
  readMarker = readKeptMarker,
} = {}) {
  const root = String(tenantRoot ?? "");
  if (root.length === 0) return { ok: false, rows: [], why: "this control plane has no tenant root configured", complete: true };
  let names;
  try { names = readdirImpl(root); }
  catch (error) {
    return { ok: false, rows: [], complete: true, why: `${root} could not be read (${String(error?.message ?? error).split("\n")[0]})` };
  }
  const rows = [];
  let complete = true;
  for (const name of [...names].sort()) {
    if (rows.length >= Math.max(1, cap)) { complete = false; break; }
    const dir = path.join(root, String(name));
    try { if (!statImpl(dir).isDirectory()) continue; }
    catch { continue; }
    const marker = readMarker(dir);
    // No marker at all is the ordinary case: a live customer's directory, or an orphan that wants an
    // operator rather than a timer. Neither is listed here and neither is ever touched.
    if (!marker.present) continue;
    rows.push({
      slug: marker.slug && marker.slug.length > 0 ? marker.slug : String(name),
      directory: dir,
      readable: marker.ok === true,
      keptUntil: marker.ok ? marker.keptUntil : null,
      removedAt: marker.ok ? marker.removedAt : null,
      days: marker.ok ? marker.days : null,
      container: marker.ok ? marker.container : "",
      reason: marker.ok ? marker.reason : "",
      why: marker.why ?? "",
    });
  }
  return { ok: true, rows, complete, why: "" };
}

/**
 * The sweep: what is kept, how big it is, and the deleting of what is past its date.
 *
 * askRelayPost is cp/provision.mjs createRelayAsk, the same one the removal's data step uses, so the
 * body and the answer this reads are the body and the answer ui/purge-edge.mjs documents. Nothing
 * here resolves a path for the relay: it sends a workspace name and the relay resolves the directory
 * out of its own tenant root, which is the rule that file exists to enforce.
 */
export function createKeptSweep({
  config,
  askRelayPost,
  now = () => Date.now(),
  log = () => {},
  measureTtlMs = KEPT_MEASURE_TTL_MS,
  cap = KEPT_LIST_CAP,
  listImpl = listKeptMarkers,
} = {}) {
  // slug -> the last answer the relay gave about this tree's size. Kept in memory on purpose: it is a
  // measurement and not a fact about the customer, so a restart losing it costs one extra walk.
  const measured = new Map();

  const rowsNow = () => listImpl({ tenantRoot: String(config?.tenantRoot ?? ""), cap });

  /** One probe. Reads and removes nothing: ui/purge-edge.mjs answers probeOnly before its confirm check. */
  async function measure(row) {
    const answer = await askRelayPost("/tenant/purge", { slug: row.slug, container: row.container, probeOnly: true });
    if (!answer.ok) {
      return { bytes: null, complete: true, at: now(), why: String(answer.why || `the relay answered ${answer.status}`) };
    }
    const dir = answer.body?.dir ?? {};
    if (dir.exists !== true) {
      return { bytes: 0, complete: true, at: now(), why: "", gone: true };
    }
    return {
      bytes: Number(dir.bytes ?? 0) || 0,
      complete: dir.complete !== false,
      at: now(),
      why: dir.complete === false ? "the relay stopped counting this tree early, so the size is short" : "",
    };
  }

  /**
   * What is being kept, with a size beside each one.
   *
   * measure false is for the sweep's second pass and for a caller that only wants the dates: it
   * answers out of whatever is already measured and asks the relay for nothing.
   */
  async function list({ measure: wanted = true } = {}) {
    const listed = rowsNow();
    const at = now();
    const rows = [];
    for (const row of listed.rows) {
      const held = measured.get(row.slug);
      const stale = held == null || at - Number(held.at ?? 0) > Math.max(0, measureTtlMs);
      const size = wanted && stale ? await measure(row) : held;
      if (size != null) measured.set(row.slug, size);
      const pastDue = row.readable && Number.isFinite(row.keptUntil) && row.keptUntil <= at;
      rows.push({
        ...row,
        keptUntil: row.keptUntil == null ? null : new Date(row.keptUntil).toISOString(),
        removedAt: row.removedAt == null ? null : new Date(row.removedAt).toISOString(),
        day: row.keptUntil == null ? "" : keptDay(row.keptUntil),
        daysLeft: row.keptUntil == null ? null : Math.ceil((row.keptUntil - at) / DAY_MS),
        pastDue,
        bytes: size?.bytes ?? null,
        size: sizeInWords(size?.bytes ?? null),
        sizeWhy: size == null ? "the size has not been asked for yet" : String(size.why ?? ""),
        sizeMeasuredAt: size?.at == null ? null : new Date(size.at).toISOString(),
      });
    }
    return {
      ok: listed.ok,
      why: listed.why,
      complete: listed.complete,
      rows,
      measuredAt: new Date(at).toISOString(),
    };
  }

  /**
   * The hourly pass. Deletes what is past its date through the relay and logs one line for each.
   *
   * A refusal is LOGGED AND LEFT, never retried into a loop and never counted as a deletion. The
   * three the route can give are all "this cannot prove the computer is gone", and a sweep that
   * deleted anyway would be the one thing ui/purge-edge.mjs exists to make impossible.
   */
  async function sweep({ reason = "timer" } = {}) {
    const answer = await list({ measure: true });
    const deleted = [];
    const refused = [];
    let bytesFreed = 0;
    for (const row of answer.rows) {
      if (!row.pastDue) continue;
      const purge = await askRelayPost("/tenant/purge", { slug: row.slug, confirm: row.slug, container: row.container });
      const removed = purge.ok && (purge.body?.removed === true || purge.body?.deleted === true || purge.body?.ok === true);
      if (!removed) {
        const why = String(purge.why || purge.body?.message || `the relay answered ${purge.status}`);
        refused.push({ slug: row.slug, why, status: purge.status, error: String(purge.body?.error ?? "") });
        log(`kept data: ${row.slug} was due on ${row.day} and was NOT deleted: ${why}`);
        continue;
      }
      const freed = Number(purge.body?.freedBytes ?? purge.body?.bytesFreed ?? row.bytes ?? 0) || 0;
      bytesFreed += freed;
      measured.delete(row.slug);
      deleted.push({ slug: row.slug, bytes: freed, size: sizeInWords(freed), day: row.day, directory: row.directory });
      // ONE LINE PER DELETION WITH THE SIZE, which is the only durable record there is: the tenant row
      // and its ledger went with the removal thirty days ago, so this line in the service's log is
      // what answers "where did that customer's files go".
      log(`kept data: ${row.slug} deleted, ${sizeInWords(freed) ?? "size not measured"} freed (kept from ${row.removedAt ? keptDay(Date.parse(row.removedAt)) : "an unrecorded day"} until ${row.day})`);
    }
    if (deleted.length === 0 && refused.length === 0) {
      const kept = answer.rows.length;
      log(answer.ok
        ? `kept data: ${kept} ${kept === 1 ? "directory" : "directories"} kept, none past its date`
        : `kept data: not swept, ${answer.why}`);
    }
    return {
      ok: answer.ok,
      why: answer.why,
      reason,
      kept: answer.rows,
      deleted,
      refused,
      bytesFreed,
      sweptAt: answer.measuredAt,
    };
  }

  return { list, sweep, measured };
}

/**
 * The hourly timer, on the pattern cp/server.mjs already uses for the box peers and the marketplace
 * re-read: unref'd so it never holds a shutdown open, and swallowing its own failures so a relay
 * that is down is never this service failing to start.
 */
export function startKeptSweepTimer({
  sweep,
  intervalMs = KEPT_SWEEP_INTERVAL_MS,
  log = () => {},
  runAtStart = true,
} = {}) {
  const run = (reason) => Promise.resolve()
    .then(() => sweep({ reason }))
    .catch((error) => { log(`kept data: the sweep stopped (${String(error?.message ?? error).split("\n")[0]})`); });
  if (runAtStart) void run("boot");
  const timer = setInterval(() => { void run("timer"); }, Math.max(60_000, intervalMs));
  timer.unref?.();
  return timer;
}
