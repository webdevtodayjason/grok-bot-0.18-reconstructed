// ui/box-health.mjs -- the facts about a customer's box that only the relay can see.
//
// ADMIN-1, item 3. The Box health panel on the admin console wants six things per customer:
// container state, whether the gateway answers, when the box last did anything, how much disk that
// customer is using, how much memory the container is holding, and which backup last contained it.
//
// Five of those six are measurable HERE and nowhere else, and the reason is in the two compose
// files. The control plane's container (deploy/coolify/control-plane.compose.yml) has exactly one
// bind mount, /data/titanbot, and deliberately NO docker socket: it reaches containers through the
// Coolify api and nothing else. The relay's container has the docker socket, has /data/titanbot,
// and already holds every tenant's gateway token so it can talk to every box. So the control plane
// asks the relay, and this file is what the relay answers with.
//
// The sixth, the backup stamp, is on neither: the archives live on /mnt/rosa-storage, which is
// mounted into no container at all. That one reads "not measured" in the panel and says why.
//
// Every number here carries the moment it was measured, because a health panel whose numbers have
// no timestamp is a panel that quietly shows yesterday.
//
// Nothing here throws. A docker that is not there, a directory that cannot be read, a box that does
// not answer: each is a field that says so, next to the fields that did work. A health report that
// fails as a whole because one probe failed is a report that is unavailable exactly when it matters.

import { execFile as execFileCb } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const DOCKER_TIMEOUT_MS = 5_000;
const GATEWAY_TIMEOUT_MS = 4_000;
// `du -sk` on a customer's whole tree is the slowest probe here by a long way, so it gets its own
// ceiling. It is also clamped to whatever is left of the sweep's budget, below.
const DISK_TIMEOUT_MS = 20_000;

// How long the WHOLE sweep may take.
//
// The control plane asks for this report over HTTP and gives up after its own ceiling, and giving
// up there never stopped the work here: the execs carried on burning the host while the panel read
// "not measured" for every box and the System panel read "the relay is not answering", which is a
// false alarm about the relay being down. So the sweep bounds itself. A customer the budget did not
// reach says so, by name, instead of the whole report arriving late or not at all.
export const SWEEP_BUDGET_MS = 8_000;
// How deep to look for a box's agent stores. deploy/backup/snapshot.sh finds them as
// volumes/data/<agent>/store.db, so two levels below volumes/data is already generous.
const ACTIVITY_DEPTH = 3;

const run = async (file, args, timeout = DOCKER_TIMEOUT_MS) => {
  try {
    const { stdout } = await execFile(file, args, { timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, out: String(stdout).trim() };
  } catch (error) {
    return { ok: false, out: "", why: String(error?.shortMessage ?? error?.message ?? error).split("\n")[0] };
  }
};

/**
 * The container's state as docker itself reports it: running, exited, paused, restarting, created.
 * "not measured" when there is no docker socket in this container, which is the honest answer for a
 * developer Mac and for any install where the relay was not given one.
 */
export async function containerState(name, { exec = run } = {}) {
  if (String(name ?? "").length === 0) return { state: "not measured", why: "this workspace has no container name" };
  const result = await exec("docker", ["inspect", "-f", "{{.State.Status}}", String(name)]);
  if (!result.ok) return { state: "not measured", why: result.why };
  return { state: result.out || "unknown" };
}

/**
 * The container's memory, from `docker stats --no-stream`. Bytes, parsed from docker's own human
 * format ("1.234GiB / 62.7GiB"), because the machine-readable form of this command does not exist.
 * A container that is not running has no stats and says so rather than reporting zero, which would
 * read as "using no memory" instead of "not running".
 */
export async function containerMemory(name, { exec = run } = {}) {
  if (String(name ?? "").length === 0) return { bytes: null, why: "this workspace has no container name" };
  const result = await exec("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", String(name)]);
  if (!result.ok) return { bytes: null, why: result.why };
  const used = result.out.split("/")[0]?.trim() ?? "";
  const match = /^([0-9.]+)\s*([KMGT]?i?B)$/i.exec(used);
  if (match == null) return { bytes: null, why: `docker said ${used || "nothing"}` };
  const scale = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  const unit = match[2].toLowerCase();
  const factor = scale[unit] ?? scale[unit.replace("i", "")] ?? 1;
  return { bytes: Math.round(Number(match[1]) * factor) };
}

/**
 * How much disk this customer is using, in kilobytes, from `du -sk` on their tenant directory. It
 * is the whole directory rather than one volume: what an operator wants to know is what this
 * customer costs, and their workspace files, their chrome profile and their agent databases are all
 * that answer.
 */
export async function tenantDisk(root, { exec = run, timeoutMs = DISK_TIMEOUT_MS } = {}) {
  if (String(root ?? "").length === 0) return { kb: null, why: "this workspace has no directory on this host" };
  const result = await exec("du", ["-sk", String(root)], Math.max(500, Math.round(Number(timeoutMs) || DISK_TIMEOUT_MS)));
  if (!result.ok) return { kb: null, why: result.why };
  const kb = Number(String(result.out).split(/\s+/)[0]);
  return Number.isFinite(kb) ? { kb } : { kb: null, why: `du said ${result.out.slice(0, 60)}` };
}

/**
 * When this box last did anything, taken as the newest write under its data volume.
 *
 * An agent's transcript lives in a sqlite store at volumes/data/<agent>/store.db, which is exactly
 * how deploy/backup/snapshot.sh finds them, so the newest mtime in that tree is the last time a
 * conversation moved. It is a lower bound and it is named as one in the docs: a box that is up and
 * idle looks the same as a box that is up and stuck, and this number cannot tell them apart. What
 * it does tell an operator is which customers are actually using the thing.
 */
export async function lastActivity(root, { depth = ACTIVITY_DEPTH } = {}) {
  const data = String(root ?? "").length === 0 ? "" : path.join(String(root), "volumes", "data");
  if (data.length === 0) return { at: null, why: "this workspace has no directory on this host" };
  let newest = 0;
  const walk = async (dir, left) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (left > 0) await walk(full, left - 1); continue; }
      if (!entry.isFile()) continue;
      try { const info = await stat(full); if (info.mtimeMs > newest) newest = info.mtimeMs; } catch { /* gone between readdir and stat */ }
    }
  };
  await walk(data, depth);
  if (newest === 0) return { at: null, why: "nothing has been written in this workspace's data volume yet" };
  return { at: new Date(newest).toISOString() };
}

/**
 * Does the box's own gateway answer? This is the one that separates "the container is running" from
 * "the product is working", and they come apart often enough to be worth asking separately: a box
 * whose host process died still has a container in state `running`.
 *
 * The tenant's own bearer, and a four second ceiling. A gateway that needs longer than that to say
 * hello is not answering as far as a person clicking around the console is concerned.
 */
export async function gatewayAnswering(gateway, token, { fetchImpl = fetch } = {}) {
  const base = String(gateway ?? "").replace(/\/+$/, "");
  if (base.length === 0) return { answering: false, why: "this workspace has no gateway address" };
  const started = Date.now();
  try {
    const response = await fetchImpl(`${base}/health`, {
      headers: String(token ?? "").length > 0 ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    // Any answer at all is the gateway being up. A 401 means it is up and did not like the bearer,
    // which is still a gateway that is answering and is worth reporting differently from silence.
    return { answering: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { answering: false, ms: Date.now() - started, why: error?.name === "TimeoutError" ? "timed out" : "no answer" };
  }
}

/**
 * The whole report, one row per workspace this relay serves.
 *
 * `entries` are tenant registry entries: {slug, name, box, gateway, token, stateDir, operator}. The
 * probes run per tenant in sequence rather than all at once, because `docker stats` on a busy host
 * is not free and a fleet of thirty would otherwise arrive as thirty simultaneous execs.
 *
 * The whole loop is capped at `budgetMs`. Sequential probes with no cap meant one customer with a
 * big directory could hold the report past the control plane's own patience, and every OTHER
 * customer's row was then lost with it. Now the slow one takes what is left of the budget and the
 * customers the sweep did not reach are named as not measured, which is a report with a hole in it
 * rather than no report.
 */
export async function readBoxHealth(entries, {
  exec = run, fetchImpl = fetch, now = () => Date.now(), budgetMs = SWEEP_BUDGET_MS,
} = {}) {
  const startedAt = now();
  const measuredAt = new Date(startedAt).toISOString();
  const budget = Number(budgetMs) > 0 ? Number(budgetMs) : Infinity;
  const boxes = [];
  let ranOut = false;
  for (const entry of entries ?? []) {
    // The tenant's root directory, worked back from the state directory the registry already
    // carries: cp/provision.mjs puts state at <root>/state. An adopted instance whose state
    // directory is somewhere else entirely gets no disk and no activity figure, which is right --
    // guessing a path and reading it would be worse than saying nothing.
    const stateDir = String(entry?.stateDir ?? "");
    const root = /\/state\/?$/.test(stateDir) ? path.dirname(stateDir.replace(/\/$/, "")) : "";
    const left = budget - (now() - startedAt);
    if (left <= 0) {
      ranOut = true;
      boxes.push(unmeasuredBox(entry, root, measuredAt,
        `the sweep ran out of its ${Math.round(budget / 1000)} second budget before it reached this workspace`));
      continue;
    }
    const [state, memory, disk, activity, gateway] = await Promise.all([
      containerState(entry?.box, { exec }),
      containerMemory(entry?.box, { exec }),
      tenantDisk(root, { exec, timeoutMs: Math.min(DISK_TIMEOUT_MS, left) }),
      lastActivity(root),
      gatewayAnswering(entry?.gateway, entry?.token, { fetchImpl }),
    ]);
    boxes.push({
      slug: String(entry?.slug ?? ""),
      name: String(entry?.name ?? ""),
      box: String(entry?.box ?? ""),
      operator: entry?.operator === true,
      root,
      containerState: state.state,
      containerStateWhy: state.why ?? "",
      memoryBytes: memory.bytes,
      memoryWhy: memory.why ?? "",
      diskKb: disk.kb,
      diskWhy: disk.why ?? "",
      lastActivityAt: activity.at,
      lastActivityWhy: activity.why ?? "",
      gatewayAnswering: gateway.answering,
      gatewayStatus: gateway.status ?? null,
      gatewayMs: gateway.ms ?? null,
      gatewayWhy: gateway.why ?? "",
      measuredAt,
    });
  }
  // `sweptEveryWorkspace` is false when the budget ran out, so the panel can say "this list is
  // short because the sweep was cut off" rather than showing a fleet that looks broken.
  return { measuredAt, budgetMs: budget === Infinity ? null : budget, sweptEveryWorkspace: !ranOut, boxes };
}

/** A row for a workspace no probe reached, in the same shape as one that was measured. */
function unmeasuredBox(entry, root, measuredAt, why) {
  return {
    slug: String(entry?.slug ?? ""),
    name: String(entry?.name ?? ""),
    box: String(entry?.box ?? ""),
    operator: entry?.operator === true,
    root,
    containerState: "not measured",
    containerStateWhy: why,
    memoryBytes: null,
    memoryWhy: why,
    diskKb: null,
    diskWhy: why,
    lastActivityAt: null,
    lastActivityWhy: why,
    gatewayAnswering: null,
    gatewayStatus: null,
    gatewayMs: null,
    gatewayWhy: why,
    measuredAt,
  };
}
