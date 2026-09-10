// ui/purge-edge.mjs -- the relay's only destructive hand: removing one workspace's data (ONBOARD-2).
//
// WHY THIS IS THE RELAY'S JOB AND NOT THE CONTROL PLANE'S, measured from inside titanbot-cp on the
// R750 on 2026-09-10: the control plane runs as uid 1001, a box's volumes/{data,workspace,chrome}
// are 0700 owned by uid 1000, and both `ls` and `touch` answer Permission denied. It physically
// cannot delete a tenant's tree. The relay runs as root, mounts /data/titanbot at the identical path
// the host uses, and already holds /var/run/docker.sock. So the control plane asks and this answers.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: IT NEVER TAKES A PATH FROM ITS CALLER. The caller sends
// a workspace name; this resolves the directory itself out of its own tenant root, and refuses
// anything whose real path is not a direct child of that root. A route that took `dir` from a body
// would be one bad control-plane config away from `rm -rf` on the wrong tree, on a server that also
// runs about twenty other people's things.
//
// FIVE REFUSALS BEFORE ANY REMOVAL, and each of them is a separate way the same accident happens:
//   1. a name that is not a workspace name at all (shape),
//   2. a reserved name, or the operator's own -- tenant `titanium` is the live console,
//   3. `..` in any form, including one that survives a path.join,
//   4. a real path that is not exactly <tenant root>/<slug>, which is what catches a symlink,
//   5. a container that is still there, or a registry that still reaches that workspace.
//
// It also answers as a pure PROBE, because the removal's container-gone step needs an honest reading
// of "is that container still running" and the relay is the only process on the machine that can
// give one. A Coolify DELETE answers 200 and dispatches its job later, and its remote block is
// wrapped in a catch that logs "Remote cleanup failed, continuing with local deletion" and deletes
// the local record anyway. So the failure that costs the most -- Coolify forgetting the service
// while the container keeps running with the customer's gateway token -- looks exactly like success
// from Coolify's side, and only a docker read tells the difference.
//
// Nothing here imports anything outside node builtins: the relay has no node_modules at all.
import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { safeEqual } from "./auth.mjs";

/** The same shape rule cp/provision.mjs validateSlug enforces, written here because ui/ cannot import cp/. */
export const PURGE_SLUG_MIN = 3;
export const PURGE_SLUG_MAX = 32;

/**
 * The names no customer may hold, and therefore the names nothing here may delete.
 *
 * A COPY of cp/provision.mjs RESERVED_SLUGS on purpose: ui/ ships to every relay and cp/ only ever
 * exists inside the control plane image, so a relay cannot import that file. Two copies of a list is
 * a drift risk, so tests/relay-purge.test.mjs imports both and holds them equal -- which is a thing
 * a test can do because it runs where both halves exist.
 */
export const PURGE_RESERVED_SLUGS = new Set([
  "www", "console", "api", "mail", "app", "admin", "status", "docs", "blog", "help", "support",
  "titanium", "titan", "resend", "send", "rsend", "_dmarc",
]);

/** How much of a tree this will walk before it stops counting and says so. */
export const PURGE_STAT_ENTRY_CAP = 200_000;

// The refusals, as named constants for the same reason cp/signup.mjs's are: a test holds each
// sentence, and a change to one of them is a change somebody makes on purpose in one place.
export const PURGE_BAD_SLUG = "That is not a workspace name, so nothing was touched.";
export const PURGE_RESERVED = "That name belongs to the product rather than to a customer, so nothing was touched.";
export const PURGE_OPERATOR = "That is this console's own workspace, so nothing was touched.";
export const PURGE_NO_ROOT = "This relay does not know where workspaces live, so nothing was touched.";
export const PURGE_ESCAPES =
  "That workspace's directory is not where it should be, so nothing was touched. Look at it by hand before anything else.";
export const PURGE_CONTAINER_PRESENT =
  "That workspace's computer is still there, so its data was left alone. Remove the container first, then ask again.";
export const PURGE_CONTAINER_UNKNOWN =
  "Nothing here can name that workspace's computer, so this cannot prove it is gone and its data was left alone.";
export const PURGE_STILL_REACHABLE =
  "This console can still reach that workspace, so its data was left alone.";
export const PURGE_CONFIRM =
  "Name the workspace in `confirm` to remove its data, so a mistyped request cannot delete anything.";

/**
 * Which directory a workspace's data is in, or why there is not one this may touch.
 *
 * Pure apart from one realpath, which is the whole point: a symlink is exactly how a directory that
 * passes every string check turns out to be somewhere else. When the directory does not exist there
 * is nothing to resolve and nothing to refuse -- `{ok: true, exists: false}` is the honest answer for
 * a workspace whose data was already gone.
 */
export async function purgePaths({
  slug,
  tenantRoot,
  operatorSlug = "",
  realpathImpl = realpath,
} = {}) {
  const name = String(slug ?? "");
  const root = String(tenantRoot ?? "");
  if (root.length === 0) return { ok: false, dir: "", exists: false, why: PURGE_NO_ROOT };
  if (name.length < PURGE_SLUG_MIN || name.length > PURGE_SLUG_MAX) return { ok: false, dir: "", exists: false, why: PURGE_BAD_SLUG };
  // The shape rule catches `..`, `a/b`, a leading dot and a leading or trailing dash all at once,
  // because none of those is a lowercase letter, a digit or an interior dash. It is written as the
  // positive rule rather than a list of bad characters for exactly that reason.
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, dir: "", exists: false, why: PURGE_BAD_SLUG };
  if (name.startsWith("-") || name.endsWith("-")) return { ok: false, dir: "", exists: false, why: PURGE_BAD_SLUG };
  if (PURGE_RESERVED_SLUGS.has(name)) return { ok: false, dir: "", exists: false, why: PURGE_RESERVED };
  if (String(operatorSlug ?? "").length > 0 && name === String(operatorSlug)) {
    return { ok: false, dir: "", exists: false, why: PURGE_OPERATOR };
  }

  const wanted = path.join(path.resolve(root), name);
  // Belt and braces over the shape rule: whatever join did, the result has to be one segment under
  // the root and that segment has to be the name that was asked for.
  if (path.dirname(wanted) !== path.resolve(root) || path.basename(wanted) !== name) {
    return { ok: false, dir: "", exists: false, why: PURGE_ESCAPES };
  }

  let realRoot;
  try { realRoot = await realpathImpl(path.resolve(root)); }
  catch { return { ok: false, dir: "", exists: false, why: PURGE_NO_ROOT }; }

  let real;
  try { real = await realpathImpl(wanted); }
  catch { return { ok: true, dir: wanted, exists: false, why: "" }; }

  // The one that catches a symlink: /data/titanbot/acme pointing at /data or at another customer's
  // tree passes every string check above and fails here.
  if (path.dirname(real) !== realRoot || path.basename(real) !== name) {
    return { ok: false, dir: real, exists: true, why: PURGE_ESCAPES };
  }
  return { ok: true, dir: real, exists: true, why: "" };
}

/**
 * How big a tree is, in bytes, with a ceiling on how much of it will be walked.
 *
 * A box's volumes hold a browser profile and a model cache, so "how many bytes did removing this
 * free" is a real number an operator wants and a walk that could take a minute is not. It counts
 * apparent sizes, follows no symlink, and says plainly when it stopped early rather than reporting a
 * number that is quietly short.
 */
export async function statTreeFs(dir, { entryCap = PURGE_STAT_ENTRY_CAP } = {}) {
  let bytes = 0;
  let files = 0;
  let complete = true;
  const stack = [String(dir ?? "")];
  try { await stat(stack[0]); } catch { return { exists: false, bytes: 0, files: 0, complete: true }; }
  while (stack.length > 0) {
    if (files >= entryCap) { complete = false; break; }
    const here = stack.pop();
    let entries;
    try { entries = await readdir(here, { withFileTypes: true }); }
    catch { complete = false; continue; }
    for (const entry of entries) {
      const full = path.join(here, entry.name);
      if (entry.isSymbolicLink()) { files += 1; continue; }
      if (entry.isDirectory()) { stack.push(full); continue; }
      files += 1;
      try { bytes += (await stat(full)).size; } catch { complete = false; }
      if (files >= entryCap) { complete = false; break; }
    }
  }
  return { exists: true, bytes, files, complete };
}

/** Removing it. One call, and it is the only line in this product that deletes a customer's data. */
export const removeTreeFs = (dir) => rm(String(dir ?? ""), { recursive: true, force: true });

/**
 * `docker ps -a --format {{.Names}}`, which is every container on this host RUNNING OR NOT.
 *
 * ui/tenant-registry.mjs dockerNameReader reads `docker ps`, which is the right question for "can
 * this workspace answer right now" and the wrong one for "is that container gone": a stopped
 * container still exists, still holds the customer's mounts and still starts again on a reboot.
 * Answers null when docker cannot be asked at all, which is a DIFFERENT answer from an empty set and
 * is why the route below refuses rather than proceeding on it.
 */
export function allDockerNames(execFile) {
  return () => new Promise((resolve) => {
    try {
      execFile("docker", ["ps", "-a", "--format", "{{.Names}}"], { timeout: 10_000, maxBuffer: 4 << 20 }, (error, stdout) => {
        if (error != null && !stdout) return resolve(null);
        const names = String(stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        resolve(new Set(names));
      });
    } catch { resolve(null); }
  });
}

/** The shape a box container's name has, so a name carried in a body can be checked before it is used. */
export const BOX_CONTAINER_RE = /^titanbot-box-[a-z0-9]{1,64}$/;

/**
 * POST /tenant/purge.
 *
 * Behind CP_RELAY_TOKEN. Answers `{container, dir}` on EVERY call, including a refusal, because the
 * removal's container-gone step uses this as a pure probe and a probe that answers nothing on a
 * refusal is a probe an operator has to guess about.
 *
 * `probeOnly: true` reads and removes nothing. Anything else is a removal and needs `confirm` to be
 * the workspace's own name, so an empty body is a 400 and never a deletion.
 */
export function createTenantPurgeRoute({
  readBody,
  drainThenEnd,
  relayToken = "",
  // () -> where workspaces live on this host. A function rather than a string so a relay that learns
  // it late, or a test that moves it, does not need this route rebuilt.
  tenantRootOf = () => "",
  // (slug) -> true while this console can still reach that workspace. A registry that still routes to
  // a box is a box that is still there whatever docker says.
  registryKnows = () => false,
  // () -> read the tenant rows again, now. The registry's reachable flag is a CACHE with a 60 second
  // timer on it, and by the time this route is asked the docker read below is seconds old and the
  // flag can be a minute old. Refusing on the older of the two facts made the caller wait out a full
  // registry cycle for a workspace whose container it had just proved absent. One refresh, one
  // re-read, and the refusal stands only if it is still true.
  refreshRegistry = async () => false,
  // (slug) -> the container name this relay knows for that workspace, or "".
  containerFor = () => "",
  // () -> a Set of every container name on this host, running or not, or null when docker is not
  // answerable.
  dockerNames = async () => null,
  removeTree = removeTreeFs,
  statTree = statTreeFs,
  operatorSlug = "",
  log = (line) => console.log(line),
} = {}) {
  const sendJson = (res, status, value, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    return res.end(JSON.stringify(value));
  };

  async function handlePurge(req, res) {
    const expected = String(relayToken ?? "");
    if (expected.length === 0) {
      return sendJson(res, 404, { message: "This relay has no control plane, so there is nothing to remove for.", removed: false, error: "not_found" });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { message: "Ask about a workspace's data with POST.", removed: false, error: "method_not_allowed" }, { allow: "POST" });
    }
    const header = String(req.headers.authorization ?? "");
    const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
    if (presented.length === 0 || !safeEqual(presented, expected)) {
      return sendJson(res, 401, { message: "That credential does not open this door, so nothing was touched.", removed: false, error: "unauthorized" });
    }

    let raw;
    try { raw = await readBody(req, 8 * 1024); }
    catch (error) {
      if (error?.code !== "BODY_TOO_LARGE") throw error;
      return drainThenEnd(req, res, 400, { "content-type": "application/json", "cache-control": "no-store" },
        JSON.stringify({ message: "That request was larger than this door takes, so nothing was touched.", removed: false, error: "too_large" }));
    }
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { body = null; }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { message: "That request was not readable, so nothing was touched.", removed: false, error: "bad_request" });
    }

    const slug = String(body.slug ?? "").trim();
    const probeOnly = body.probeOnly === true;

    const where = await purgePaths({ slug, tenantRoot: tenantRootOf(), operatorSlug });
    const dirPath = String(where.dir ?? "");
    const measured = where.ok && where.exists ? await statTree(dirPath) : { exists: false, bytes: 0, files: 0, complete: true };

    // WHICH CONTAINER, and the order matters. The registry's own reading first, because it is this
    // relay's own knowledge; then a name the caller carried, shape-checked, because by the time the
    // data is removed the registry has already forgotten the workspace and the control plane's tenant
    // row is the only thing left that knows the name. A name is not a path and nothing is resolved
    // from it: it is compared against a list of what docker says exists.
    const known = String(containerFor(slug) ?? "").trim();
    const carried = String(body.container ?? "").trim();
    const containerName = known.length > 0 ? known : (BOX_CONTAINER_RE.test(carried) ? carried : "");
    const names = await Promise.resolve().then(() => dockerNames()).catch(() => null);
    const dockerAnswered = names != null;
    const present = containerName.length > 0 && dockerAnswered ? names.has(containerName) : null;

    const answer = (status, message, extra = {}) => sendJson(res, status, {
      message,
      removed: false,
      slug,
      container: { name: containerName, present, known: containerName.length > 0, dockerAnswered },
      dir: { path: dirPath, exists: measured.exists === true, bytes: Number(measured.bytes ?? 0), complete: measured.complete !== false },
      reachable: registryKnows(slug) === true,
      ...extra,
    });

    if (!where.ok) return answer(400, where.why, { error: "refused" });
    if (probeOnly) return answer(200, "Nothing was touched.", { probeOnly: true });

    if (String(body.confirm ?? "") !== slug) return answer(400, PURGE_CONFIRM, { error: "confirm" });
    // A container that is still there, or one nothing can name, or a docker that would not answer.
    // All three mean the same thing: this cannot prove the computer is gone, so the data stays.
    if (containerName.length === 0) return answer(409, PURGE_CONTAINER_UNKNOWN, { error: "container_unknown" });
    if (!dockerAnswered) return answer(409, PURGE_CONTAINER_UNKNOWN, { error: "container_unknown" });
    if (present === true) return answer(409, PURGE_CONTAINER_PRESENT, { error: "container_present" });
    // THE CACHED FLAG IS OLDER THAN THE DOCKER READ THIS CALL JUST MADE, and that order is the whole
    // point: `present` is false as of milliseconds ago, so a registry still saying "reachable" is a
    // registry that has not looked since the container went. Ask it to look, then believe it. Only
    // when it is the one thing left standing in the way -- a container that IS present is refused
    // above and no refresh is attempted, because nothing a registry says could change that answer.
    let refreshed = false;
    if (registryKnows(slug) === true) {
      refreshed = true;
      try { await refreshRegistry(); } catch { /* a registry that would not refresh is still a refusal */ }
      if (registryKnows(slug) === true) return answer(409, PURGE_STILL_REACHABLE, { error: "still_reachable", refreshed });
    }

    if (!measured.exists) {
      return sendJson(res, 200, {
        message: "There was nothing left to remove.",
        removed: true,
        slug,
        container: { name: containerName, present, known: true, dockerAnswered },
        dir: { path: dirPath, exists: false, bytes: 0, complete: true },
        freedBytes: 0,
        refreshed,
      });
    }

    const before = Number(measured.bytes ?? 0);
    try { await removeTree(dirPath); }
    catch (error) {
      log(`purge ${slug}: ${dirPath} could not be removed: ${String(error?.message ?? error)}`);
      return answer(500, "That workspace's data could not be removed, so it is still there.", { error: "remove_failed" });
    }
    // Re-stat rather than trust the removal: an rm that answered without throwing and left a tree
    // behind is exactly the state an operator must not be told is finished.
    const after = await statTree(dirPath);
    log(`purge ${slug}: removed ${dirPath} (${before} bytes)`);
    return sendJson(res, 200, {
      message: after.exists === true
        ? "Some of that workspace's data is still there."
        : `That workspace's data is gone. ${before} bytes freed.`,
      removed: after.exists !== true,
      slug,
      container: { name: containerName, present, known: true, dockerAnswered },
      dir: { path: dirPath, exists: after.exists === true, bytes: Number(after.bytes ?? 0), complete: after.complete !== false },
      freedBytes: before,
      refreshed,
    });
  }

  return { handlePurge };
}
