// tests/purge-double.mjs -- the /tenant/purge double, built out of the route it stands in for.
//
// WHY THIS FILE EXISTS. ONBOARD-2 shipped both ends of a new HTTP contract: cp/decommission.mjs
// asking and ui/purge-edge.mjs answering. Each end had its own suite, each suite was green, and the
// two did not agree on a single field. The control plane sent `{slug}` where the route refuses
// anything without `confirm`, and read `deleted`/`bytesFreed` where the route answers
// `removed`/`freedBytes`. Two hand-written fakes -- one in tests/cp-support.mjs, one in
// tests/onboard-seam.test.mjs -- both encoded the caller's wrong guess, so 78 tests held the bug in
// place and tests/relay-purge.test.mjs asserted the opposite on the other side of the same wire.
//
// So no test writes this contract out by hand any more. The double IS `createTenantPurgeRoute`, and
// only the three things a test machine cannot have are injected: which containers are on the host,
// whether the console can still reach the workspace, and how big a tree is. If the route's body or
// its answer ever changes, every caller's test changes with it in the same commit.
import path from "node:path";

import { createTenantPurgeRoute, removeTreeFs } from "../ui/purge-edge.mjs";

/**
 * A handler for POST /tenant/purge, for a fake relay that has already read the request body.
 *
 * rows       slug -> {path, bytes}: the trees this relay believes in. A purge deletes from here AND
 *            off the disk, so a test can assert both the record and the directory are gone.
 * containerFor  (slug) -> the container name this relay's registry knows, or "".
 * onHost     (name) -> is that container on this host right now, running or not. Read from the fake
 *            Coolify's HOST set and never from its service records, because the failure this step
 *            exists for is the record gone and the container still up.
 * tenantRootOf  () -> where workspaces live. A real directory: the route realpaths it.
 * state.registryLag  how many more times registryKnows answers true after the container is gone,
 *            which is the real relay's registry refresh and the reason the caller has to poll.
 * state.purgeRefusal  set to a sentence and the door answers 409 before the route is reached, for
 *            the test that watches a removal carry on past a purge it could not have.
 */
export function makePurgeDouble({
  relayToken,
  tenantRootOf,
  containerFor = () => "",
  onHost = () => false,
  rows,
  state,
  operatorSlug = "",
}) {
  const route = createTenantPurgeRoute({
    readBody: async (req) => String(req.rawBodyText ?? ""),
    drainThenEnd: (req, res, status, headers, body) => { res.writeHead(status, headers); res.end(body); },
    relayToken,
    tenantRootOf,
    // A registry that still routes to a workspace is a workspace that is still there, whatever one
    // container name says. It clears itself one refresh after the container goes, and `registryLag`
    // is that refresh: the caller must ask again rather than read a 409 as a failure.
    registryKnows: (slug) => {
      if (Number(state?.registryLag ?? 0) > 0) { state.registryLag -= 1; return true; }
      const name = containerFor(slug);
      return String(name ?? "").length > 0 && onHost(name) === true;
    },
    containerFor,
    dockerNames: async () => {
      if (state?.dockerSilent === true) return null;
      const names = new Set();
      for (const slug of rows.keys()) {
        const name = containerFor(slug);
        if (String(name ?? "").length > 0 && onHost(name) === true) names.add(name);
      }
      // Anything the test put on the host that has no row here still counts: the point of the host
      // view is that it is not the control plane's list.
      for (const extra of state?.extraContainers ?? []) names.add(String(extra));
      return names;
    },
    // The bytes a test declared, rather than the handful of bytes a temporary directory really holds.
    // The route only ever calls this for a directory it has already realpath'd, so the tree is real
    // and only its size is the test's.
    statTree: async (dir) => {
      const row = rows.get(path.basename(String(dir ?? "")));
      if (row == null) return { exists: false, bytes: 0, files: 0, complete: true };
      return { exists: true, bytes: Number(row.bytes ?? 0), files: 1, complete: true };
    },
    removeTree: async (dir) => {
      rows.delete(path.basename(String(dir ?? "")));
      await removeTreeFs(dir);
    },
    operatorSlug,
    log: () => {},
  });

  return async function handle(req, res, rawBodyText) {
    req.rawBodyText = rawBodyText;
    return route.handlePurge(req, res);
  };
}
