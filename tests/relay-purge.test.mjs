// ONBOARD-2. The relay's only destructive route: POST /tenant/purge.
//
// This is the one place in the product that can delete a customer's data, so every case below is
// about a way that could go wrong rather than a way it should go right. The control plane cannot do
// this at all: measured from inside titanbot-cp on the R750 2026-09-10, cp runs as uid 1001, a box's
// volumes are 0700 owned by uid 1000, and both ls and touch answer Permission denied. The relay runs
// as root with /data/titanbot mounted and the docker socket, so it is the only process that can, and
// therefore the only one that has to be held to these rules.
//
// THE RULE THE FILE EXISTS FOR: the route never takes a path from its caller. It takes a workspace
// name, resolves the directory itself out of its own tenant root, and refuses anything whose real
// path is not a direct child of that root -- which is what catches a symlink that passes every
// string check.
//
// AND THE PROOF THE ROUTE IS REALLY FOR: a Coolify DELETE answers 200 and dispatches its job later,
// with the remote block wrapped in a catch that logs "Remote cleanup failed, continuing with local
// deletion" and deletes the local record anyway. So the worst failure -- Coolify forgetting the
// service while the container keeps running with the customer's gateway token -- looks like success
// from Coolify's side. Only a docker read tells the difference, and only this relay can make one.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BOX_CONTAINER_RE,
  PURGE_BAD_SLUG,
  PURGE_CONFIRM,
  PURGE_CONTAINER_PRESENT,
  PURGE_CONTAINER_UNKNOWN,
  PURGE_ESCAPES,
  PURGE_NO_ROOT,
  PURGE_OPERATOR,
  PURGE_RESERVED,
  PURGE_RESERVED_SLUGS,
  PURGE_STILL_REACHABLE,
  createTenantPurgeRoute,
  purgePaths,
  statTreeFs,
} from "../ui/purge-edge.mjs";
import { RESERVED_SLUGS } from "../cp/provision.mjs";

const RELAY_TOKEN = "a-relay-token-long-enough-to-be-real-enough";
const SLUG = "acme-roofing";
const CONTAINER = "titanbot-box-p927bfqm83ioloibamlvyd7g";

/** A tenant root with one workspace's tree in it, real files and all. */
async function withRoot(run) {
  // REALPATHED, because on macOS os.tmpdir() is /var/... which is a symlink to /private/var, and this
  // route resolves the real path on purpose. A test comparing against the unresolved name would be
  // asserting the resolver does NOT work.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "relay-purge-")));
  try {
    await mkdir(path.join(root, "tenants", SLUG, "volumes", "data"), { recursive: true });
    await mkdir(path.join(root, "tenants", SLUG, "state"), { recursive: true });
    await mkdir(path.join(root, "tenants", "other-co"), { recursive: true });
    await writeFile(path.join(root, "tenants", SLUG, "volumes", "data", "store.db"), "x".repeat(4096));
    await writeFile(path.join(root, "tenants", SLUG, "state", "mail.json"), "{}");
    await writeFile(path.join(root, "tenants", "other-co", "keep.txt"), "not this one");
    await run({ root, tenants: path.join(root, "tenants") });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function fakeRes() {
  return {
    status: 0, headers: {}, body: null,
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; return this; },
    end(payload) { this.body = payload == null ? null : JSON.parse(String(payload)); return this; },
  };
}

const fakeReq = (body, { method = "POST", token = RELAY_TOKEN } = {}) => ({
  method,
  headers: token == null ? {} : { authorization: `Bearer ${token}` },
  raw: typeof body === "string" ? body : JSON.stringify(body ?? {}),
});

function routeWith(tenants, overrides = {}) {
  const seen = { removed: [], logs: [] };
  const route = createTenantPurgeRoute({
    readBody: async (req, max) => {
      if (req.raw.length > max) { const error = new Error("too large"); error.code = "BODY_TOO_LARGE"; throw error; }
      return req.raw;
    },
    drainThenEnd: async (req, res, status, headers, payload) => { res.writeHead(status, headers); res.end(payload); },
    relayToken: RELAY_TOKEN,
    tenantRootOf: () => tenants,
    registryKnows: () => false,
    containerFor: () => "",
    dockerNames: async () => new Set(["titanbot-relay-abc", "titanbot-cp"]),
    removeTree: async (dir) => { seen.removed.push(dir); await rm(dir, { recursive: true, force: true }); },
    operatorSlug: "operator",
    log: (line) => seen.logs.push(line),
    ...overrides,
  });
  return { seen, route };
}

const call = async (tenants, body, options = {}, overrides = {}) => {
  const { seen, route } = routeWith(tenants, overrides);
  const res = fakeRes();
  await route.handlePurge(fakeReq(body, options), res);
  return { seen, res };
};

const exists = async (dir) => stat(dir).then(() => true, () => false);

// ---- purgePaths, the resolver ------------------------------------------------------------------

test("purgePaths refuses every spelling of a name that is not a workspace name", async () => {
  await withRoot(async ({ tenants }) => {
    for (const bad of [
      "..", "../..", "a/../..", "acme/../../etc", "..%2f..", ".hidden", "AcmeRoofing",
      "acme roofing", "acme_roofing", "-acme", "acme-", "ab", "x".repeat(33), "", "acme/roofing",
      "/etc/passwd",
      // Written as an escape rather than as the byte itself, so this suite stays a text file: a raw
      // NUL makes the repository read the whole thing as binary and stop diffing it. The case is
      // real all the same, because a NUL is the classic way a name that looks fine to one layer is
      // truncated by another.
      "acme\u0000roofing", "acme%00roofing",
    ]) {
      const answer = await purgePaths({ slug: bad, tenantRoot: tenants, operatorSlug: "operator" });
      assert.equal(answer.ok, false, `"${bad}" must be refused`);
      assert.equal(answer.why, PURGE_BAD_SLUG, `"${bad}"`);
      assert.equal(answer.dir, "", `"${bad}" must resolve to no directory at all`);
    }
  });
});

test("purgePaths refuses a reserved name and the operator's own, and the two lists cannot drift", async () => {
  await withRoot(async ({ tenants }) => {
    // ui/ cannot import cp/, so PURGE_RESERVED_SLUGS is a copy of cp/provision.mjs's list. A test can
    // import both, which is what keeps two copies of one list honest.
    assert.deepEqual([...PURGE_RESERVED_SLUGS].sort(), [...RESERVED_SLUGS].sort());
    // titanium is the live console's own tenant on the R750, so this is not a hypothetical.
    for (const reserved of ["titanium", "console", "api", "admin", "support"]) {
      const answer = await purgePaths({ slug: reserved, tenantRoot: tenants, operatorSlug: "operator" });
      assert.equal(answer.ok, false, reserved);
      assert.equal(answer.why, PURGE_RESERVED, reserved);
    }
    const operator = await purgePaths({ slug: "operator", tenantRoot: tenants, operatorSlug: "operator" });
    assert.equal(operator.ok, false);
    assert.equal(operator.why, PURGE_OPERATOR);
  });
});

test("purgePaths refuses a directory that is really somewhere else", async () => {
  await withRoot(async ({ root, tenants }) => {
    const elsewhere = path.join(root, "not-a-tenant");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(tenants, "sneaky-co"));
    const answer = await purgePaths({ slug: "sneaky-co", tenantRoot: tenants, operatorSlug: "operator" });
    assert.equal(answer.ok, false);
    assert.equal(answer.why, PURGE_ESCAPES);
    // The name passed every string check. Only the real path tells the truth, which is the whole
    // reason this resolver is not a string comparison.
    assert.equal(await exists(elsewhere), true);
  });
});

test("purgePaths with no root, and with a workspace whose data is already gone", async () => {
  await withRoot(async ({ tenants }) => {
    assert.equal((await purgePaths({ slug: SLUG, tenantRoot: "" })).why, PURGE_NO_ROOT);
    // Nothing there is the honest answer for a workspace removed twice, not a refusal.
    const missing = await purgePaths({ slug: "never-existed", tenantRoot: tenants, operatorSlug: "operator" });
    assert.equal(missing.ok, true);
    assert.equal(missing.exists, false);
    assert.equal(missing.dir, path.join(tenants, "never-existed"));
    // And the real one resolves to exactly one directory under the root.
    const real = await purgePaths({ slug: SLUG, tenantRoot: tenants, operatorSlug: "operator" });
    assert.equal(real.ok, true);
    assert.equal(real.exists, true);
    assert.equal(path.basename(real.dir), SLUG);
  });
});

test("statTreeFs measures the tree and says when it stopped early", async () => {
  await withRoot(async ({ tenants }) => {
    const measured = await statTreeFs(path.join(tenants, SLUG));
    assert.equal(measured.exists, true);
    assert.ok(measured.bytes >= 4096, `${measured.bytes} bytes`);
    assert.equal(measured.files, 2);
    assert.equal(measured.complete, true);
    const capped = await statTreeFs(path.join(tenants, SLUG), { entryCap: 1 });
    assert.equal(capped.complete, false, "a number that is quietly short is worse than one that says so");
    assert.equal((await statTreeFs(path.join(tenants, "gone"))).exists, false);
  });
});

// ---- the door ------------------------------------------------------------------------------------

test("an unauthenticated POST is 401, a GET is 405, and a relay with no control plane has no door", async () => {
  await withRoot(async ({ tenants }) => {
    const missing = await call(tenants, { slug: SLUG, confirm: SLUG }, { token: null });
    assert.equal(missing.res.status, 401);
    assert.equal(missing.seen.removed.length, 0);

    const wrong = await call(tenants, { slug: SLUG, confirm: SLUG }, { token: "not-the-token" });
    assert.equal(wrong.res.status, 401);

    const get = await call(tenants, {}, { method: "GET", token: null });
    assert.equal(get.res.status, 405);
    assert.equal(get.res.headers.allow, "POST");

    const nowhere = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, { relayToken: "" });
    assert.equal(nowhere.res.status, 404);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

// ---- the probe -----------------------------------------------------------------------------------

test("probeOnly answers what is there and removes nothing, which is what proves a container is gone", async () => {
  await withRoot(async ({ tenants }) => {
    const running = await call(tenants, { slug: SLUG, probeOnly: true }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set([CONTAINER, "titanbot-relay-abc"]),
    });
    assert.equal(running.res.status, 200);
    assert.equal(running.res.body.removed, false);
    assert.equal(running.res.body.container.name, CONTAINER);
    assert.equal(running.res.body.container.present, true);
    assert.equal(running.res.body.dir.exists, true);
    assert.ok(running.res.body.dir.bytes >= 4096);
    assert.equal(running.seen.removed.length, 0);
    assert.equal(await exists(path.join(tenants, SLUG)), true);

    // And once the container really is gone, which is the reading the removal waits for.
    const gone = await call(tenants, { slug: SLUG, probeOnly: true }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
    });
    assert.equal(gone.res.body.container.present, false);
    assert.equal(gone.seen.removed.length, 0);
  });
});

test("a probe still answers the container and the directory when the name is refused", async () => {
  await withRoot(async ({ tenants }) => {
    // A refusal that answers nothing is a refusal an operator has to guess about.
    const { res } = await call(tenants, { slug: "titanium", probeOnly: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, PURGE_RESERVED);
    assert.ok(Object.hasOwn(res.body, "container"));
    assert.ok(Object.hasOwn(res.body, "dir"));
  });
});

test("a container name the caller carried is used when the registry has already forgotten the workspace", async () => {
  await withRoot(async ({ tenants }) => {
    // By the time the data is removed the registry has dropped the entry, so the control plane's own
    // tenant row is the only thing left that knows the name. A NAME is not a path, and nothing is
    // resolved from it: it is compared against what docker says exists.
    const carried = await call(tenants, { slug: SLUG, confirm: SLUG, container: CONTAINER }, {}, {
      dockerNames: async () => new Set([CONTAINER]),
    });
    assert.equal(carried.res.status, 409);
    assert.equal(carried.res.body.message, PURGE_CONTAINER_PRESENT);
    assert.equal(carried.seen.removed.length, 0);

    // A carried name that is not a box container's name at all is not used.
    const nonsense = await call(tenants, { slug: SLUG, confirm: SLUG, container: "/etc/passwd" });
    assert.equal(nonsense.res.status, 409);
    assert.equal(nonsense.res.body.message, PURGE_CONTAINER_UNKNOWN);
    assert.equal(BOX_CONTAINER_RE.test("/etc/passwd"), false);
    assert.equal(BOX_CONTAINER_RE.test(CONTAINER), true);
  });
});

// ---- the removal, and the four things that stop it ----------------------------------------------

test("an empty body never deletes anything: the workspace's own name has to be typed back", async () => {
  await withRoot(async ({ tenants }) => {
    for (const body of [{}, { slug: SLUG }, { slug: SLUG, confirm: "acme" }, { slug: SLUG, confirm: "" }]) {
      const { seen, res } = await call(tenants, body, {}, { containerFor: () => CONTAINER });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(seen.removed.length, 0);
    }
    const named = await call(tenants, { slug: SLUG, confirm: "acme" }, {}, { containerFor: () => CONTAINER });
    assert.equal(named.res.body.message, PURGE_CONFIRM);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("a container that is still there, or one nothing can name, leaves the data alone", async () => {
  await withRoot(async ({ tenants }) => {
    const present = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set([CONTAINER]),
    });
    assert.equal(present.res.status, 409);
    assert.equal(present.res.body.message, PURGE_CONTAINER_PRESENT);
    assert.equal(present.res.body.error, "container_present");
    assert.equal(present.seen.removed.length, 0);

    // Nothing can name it: a removal that cannot prove the computer is gone must not go ahead, because
    // a container still running with the customer's gateway token is the failure that costs the most.
    const unnamed = await call(tenants, { slug: SLUG, confirm: SLUG });
    assert.equal(unnamed.res.status, 409);
    assert.equal(unnamed.res.body.message, PURGE_CONTAINER_UNKNOWN);

    // Docker itself would not answer, which is a DIFFERENT thing from an empty list and must not read
    // as "no such container".
    const blind = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => null,
    });
    assert.equal(blind.res.status, 409);
    assert.equal(blind.res.body.container.dockerAnswered, false);
    assert.equal(blind.seen.removed.length, 0);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("a workspace this console can still reach leaves the data alone whatever docker says", async () => {
  await withRoot(async ({ tenants }) => {
    const { seen, res } = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
      registryKnows: () => true,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, PURGE_STILL_REACHABLE);
    assert.equal(seen.removed.length, 0);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("a registry that is a minute behind a docker read it just made is refreshed once, and then the tree goes", async () => {
  // ONBOARD-2, and the arithmetic that made this necessary. registryKnows reads a CACHED reachable
  // flag whose refresh timer is 60 seconds. `present` is read from docker in this same call, so it is
  // milliseconds old. When the two disagree the newer one is the one to act on, and on the R750 on
  // 2026-09-10 the control plane's removal asked, was told still_reachable, and its 30 second poll
  // lost to the 60 second timer every time. One refresh and one re-read turns a minute into a round
  // trip.
  await withRoot(async ({ tenants }) => {
    let refreshes = 0;
    let stale = true;
    const { seen, res } = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
      registryKnows: () => stale,
      refreshRegistry: async () => { refreshes += 1; stale = false; return true; },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(refreshes, 1, "exactly one refresh, not a loop");
    assert.equal(res.body.removed, true);
    assert.equal(res.body.refreshed, true, "and the answer says the extra round trip happened");
    assert.ok(res.body.freedBytes >= 4096, `${res.body.freedBytes} bytes freed`);
    assert.equal(seen.removed.length, 1);
    assert.equal(await exists(path.join(tenants, SLUG)), false);
  });
});

test("a registry that still reaches the workspace after a refresh refuses, and a container that is there is refused without one", async () => {
  await withRoot(async ({ tenants }) => {
    // The refresh happened and the answer did not change, so the refusal is the current truth.
    let refreshes = 0;
    const held = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
      registryKnows: () => true,
      refreshRegistry: async () => { refreshes += 1; return true; },
    });
    assert.equal(held.res.status, 409);
    assert.equal(held.res.body.message, PURGE_STILL_REACHABLE);
    assert.equal(held.res.body.refreshed, true);
    assert.equal(refreshes, 1);
    assert.equal(held.seen.removed.length, 0);
    assert.equal(await exists(path.join(tenants, SLUG)), true);

    // AND A CONTAINER THAT IS REALLY THERE IS REFUSED WITH NO REFRESH AT ALL. Nothing a registry
    // could say would change that answer, and a refresh here would only be a call the product makes
    // for no reason on the one path where it must do the least.
    let second = 0;
    const present = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set([CONTAINER]),
      registryKnows: () => true,
      refreshRegistry: async () => { second += 1; return true; },
    });
    assert.equal(present.res.status, 409);
    assert.equal(present.res.body.message, PURGE_CONTAINER_PRESENT);
    assert.equal(second, 0, "a container that is present asked the registry to look again");
    assert.equal(present.seen.removed.length, 0);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("with the container gone and the name typed back, the tree goes and the answer is re-measured", async () => {
  await withRoot(async ({ tenants }) => {
    const { seen, res } = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removed, true);
    assert.ok(res.body.freedBytes >= 4096, `${res.body.freedBytes} bytes freed`);
    // Re-stat rather than trust the removal: an rm that answered without throwing and left a tree
    // behind is exactly the state an operator must not be told is finished.
    assert.equal(res.body.dir.exists, false);
    assert.equal(await exists(path.join(tenants, SLUG)), false);
    // And ONLY that one. The neighbour is untouched, which is the whole reason the path is resolved
    // here and never carried in a body.
    assert.equal(await exists(path.join(tenants, "other-co", "keep.txt")), true);
    assert.equal(seen.removed.length, 1);
    assert.equal(seen.removed[0], path.join(tenants, SLUG));
    assert.match(seen.logs.join("\n"), /purge acme-roofing: removed/);
  });
});

test("removing a workspace whose data is already gone is a success and not an error", async () => {
  await withRoot(async ({ tenants }) => {
    const { seen, res } = await call(tenants, { slug: "never-existed", confirm: "never-existed" }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, true);
    assert.equal(res.body.freedBytes, 0);
    assert.equal(seen.removed.length, 0);
  });
});

test("a removal that leaves something behind says so rather than reporting a clean finish", async () => {
  await withRoot(async ({ tenants }) => {
    const { res } = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
      // An rm that answers without throwing and removes nothing, which is what a permission problem or
      // a busy mount looks like from here.
      removeTree: async () => {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, false);
    assert.match(res.body.message, /still there/);
    assert.equal(res.body.dir.exists, true);
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("a removal that throws leaves the data and says the data is still there", async () => {
  await withRoot(async ({ tenants }) => {
    const { res } = await call(tenants, { slug: SLUG, confirm: SLUG }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
      removeTree: async () => { throw new Error("EBUSY"); },
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "remove_failed");
    assert.equal(await exists(path.join(tenants, SLUG)), true);
  });
});

test("the route never takes a path from its caller, however the caller spells it", async () => {
  await withRoot(async ({ root, tenants }) => {
    // Every one of these is a field a route written the obvious way might have read. None of them is
    // read: the directory comes from the tenant root and the slug and nothing else.
    const { seen, res } = await call(tenants, {
      slug: SLUG, confirm: SLUG,
      dir: root, path: root, directory: root, tenantRoot: "/", root: "/",
    }, {}, {
      containerFor: () => CONTAINER,
      dockerNames: async () => new Set(["titanbot-relay-abc"]),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.removed[0], path.join(tenants, SLUG));
    assert.equal(await exists(path.join(tenants, "other-co")), true);
    assert.equal(await exists(root), true);
  });
});
