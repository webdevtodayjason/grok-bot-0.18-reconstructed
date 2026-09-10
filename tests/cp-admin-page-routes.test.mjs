// ADMIN-4. Every route the super admin console calls has to open to the credential the console
// actually holds.
//
// A browser signed in at /admin holds a SESSION TOKEN from POST /v1/sessions. It does not hold
// CP_ADMIN_TOKEN and never will: that value is the operator's own bearer, it lives in the control
// plane's environment, and no page has any way to learn it. So a route the page calls that is
// guarded by cp/server.mjs's requireAdmin -- a constant-time compare against CP_ADMIN_TOKEN and
// nothing else -- answers the page 401 forever.
//
// That is not a panel drawing an empty table. cp/admin/admin.js's api() treats ANY 401 as "this
// session died" and signs the person out with "That session is no longer valid. Sign in again."
// One route on one panel is enough to throw the operator back to the door, because the Overview
// loads several panels at once. On 2026-09-10 that route was GET /v1/voice/usage, added by the
// voice wave with requireAdmin, and every super admin was ejected about two seconds after signing
// in. Measured on the R750 that morning; the row is docs/GAP-ANALYSIS.md ADMIN-4.
//
// This test is written so the NEXT wave cannot do it again. It does not carry a hand-written list
// of routes that would go stale the day someone adds a panel. It reads cp/admin/admin.js, pulls out
// every api("METHOD", "<path>") literal the page can call, stands the control plane up in process,
// mints a super admin, signs in, and probes all of them with that session token. A 400 or a 404 or
// a 405 is fine -- the probe sends no body and substitutes a placeholder for every ${...} in a
// template path, so a route is entitled to say the request is wrong. A 401 is the outage.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startControlPlane } from "./cp-support.mjs";

const PASSWORD = "a-good-password";
const ADMIN_JS = fileURLToPath(new URL("../cp/admin/admin.js", import.meta.url));

// Whatever a ${...} in a template path is filled with at runtime, standing in for a workspace slug,
// an account id, a provider id, a plan-model alias or a verb. Nothing in a fresh temporary store is
// called this, so every probe lands on a row that does not exist, which is exactly what makes the
// probes safe to fire at POST routes.
const PLACEHOLDER = "admin4-probe";

/**
 * Every route cp/admin/admin.js can call, read out of the file itself.
 *
 * Hand-rolled rather than regexed because the paths are template literals and at least one of them
 * carries a ternary with quoted strings inside the ${...}:
 *
 *   api("POST", `/v1/admin/users/${encodeURIComponent(user.id)}/${user.disabled ? "enable" : "disable"}`)
 *
 * A regex that stops at the first quote silently drops that route, and a route silently dropped
 * from this list is a route this test stops protecting -- the exact failure it exists to catch.
 */
export function pageRoutes(source) {
  const found = new Map();
  const opener = /\bapi\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*/g;
  let match;
  while ((match = opener.exec(source)) != null) {
    const method = match[1];
    let at = opener.lastIndex;
    const quote = source[at];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    at += 1;
    let path = "";
    let done = false;
    while (at < source.length && !done) {
      const ch = source[at];
      if (ch === "\\") { path += source[at + 1] ?? ""; at += 2; continue; }
      if (ch === quote) { done = true; at += 1; break; }
      if (quote === "`" && ch === "$" && source[at + 1] === "{") {
        // Walk the expression to its matching brace, skipping any string literal inside it so a
        // quoted "}" could never end the walk early. What it evaluates to does not matter here.
        at += 2;
        let depth = 1;
        while (at < source.length && depth > 0) {
          const inner = source[at];
          if (inner === "{") { depth += 1; at += 1; continue; }
          if (inner === "}") { depth -= 1; at += 1; continue; }
          if (inner === '"' || inner === "'" || inner === "`") {
            const end = inner;
            at += 1;
            while (at < source.length && source[at] !== end) { at += source[at] === "\\" ? 2 : 1; }
            at += 1;
            continue;
          }
          at += 1;
        }
        path += PLACEHOLDER;
        continue;
      }
      path += ch;
      at += 1;
    }
    if (!done || !path.startsWith("/v1/")) continue;
    found.set(`${method} ${path}`, { method, path });
  }
  return [...found.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

test("the console's own file still parses into a real list of routes", () => {
  const routes = pageRoutes(readFileSync(ADMIN_JS, "utf8"));
  // A floor, not a count: the point is that a broken reader cannot make this whole file pass by
  // finding nothing. The number moves whenever a panel gains a button, and that is fine.
  assert.ok(routes.length >= 30, `only ${routes.length} routes came out of cp/admin/admin.js`);
  const names = routes.map((route) => `${route.method} ${route.path}`);
  // The two that do NOT live under /v1/admin, because cp/admin.mjs claims that whole prefix and
  // answers 404 to anything it does not match itself. They are the ones a wave can add a guard to
  // without ever opening the admin API, so they are named here on purpose.
  assert.ok(names.includes("GET /v1/voice/usage"), "the Spend panel's voice read");
  assert.ok(names.includes("GET /v1/code/tasks"), "the Spend panel's coding read");
  // The ternary route, which is the one a naive regex drops.
  assert.ok(
    names.some((name) => name.startsWith("POST /v1/admin/users/") && name.endsWith(`/${PLACEHOLDER}`)),
    "the enable/disable button on the Clients panel",
  );
});

test("no route the admin page calls answers 401 to a super admin's session token", async () => {
  const plane = await startControlPlane();
  try {
    await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "svc-existing", host: "titanium.titanium.bot" });
    const created = await plane.admin("POST", "/v1/accounts", {
      email: "admin4@example.com", password: PASSWORD, name: "The Operator", tenant: "titanium",
    });
    assert.equal(created.status, 201, created.text);
    // Promoted through the store the same way `cp admin promote` does it. The flag is looked up on
    // every request rather than carried in the token, so this takes effect immediately.
    plane.store.setSuperAdmin(created.body.account.email, true);

    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "admin4@example.com", password: PASSWORD } });
    assert.equal(signIn.status, 200, signIn.text);
    assert.equal(signIn.body.account.superAdmin, true);
    const token = signIn.body.token;

    const routes = pageRoutes(readFileSync(ADMIN_JS, "utf8"));
    const ejected = [];
    for (const route of routes) {
      const answer = await plane.request(route.method, route.path, { token });
      // 400, 404, 405, 409 and even 502 are all a route TALKING to this session. Only 401 is the
      // door, and the door is what api() turns into a sign-out.
      if (answer.status === 401) ejected.push(`${route.method} ${route.path}`);
    }
    assert.deepEqual(ejected, [], `these routes sign a super admin out: ${ejected.join(", ")}`);

    // Named on its own as well as swept above, because this is the route that caused the outage and
    // a sweep that quietly stopped covering it would look exactly like a sweep that passes.
    const usage = await plane.request("GET", "/v1/voice/usage", { token });
    assert.equal(usage.status, 200, usage.text);

    // And the operator's CLI, which holds the bearer and no session, still opens the same two.
    assert.equal((await plane.admin("GET", "/v1/voice/usage")).status, 200);
    assert.equal((await plane.admin("GET", "/v1/code/tasks")).status, 200);
  } finally {
    await plane.dispose();
  }
});

test("a session that is not a super admin's opens none of it", async () => {
  const plane = await startControlPlane();
  try {
    await plane.admin("POST", "/v1/tenants/acme/adopt", { coolifyServiceUuid: "svc-existing", host: "acme.titanium.bot" });
    const created = await plane.admin("POST", "/v1/accounts", { email: "owner@example.com", password: PASSWORD, tenant: "acme" });
    assert.equal(created.status, 201, created.text);
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    assert.equal(signIn.status, 200, signIn.text);
    assert.equal(signIn.body.account.superAdmin, false);
    const token = signIn.body.token;

    // Widening the guard on the voice pair widened it to SUPER ADMINS, not to everybody holding a
    // valid session. A customer's own owner is a valid session on this same service.
    assert.equal((await plane.request("GET", "/v1/voice/usage", { token })).status, 401);
    assert.equal((await plane.request("POST", "/v1/voice/caps", { token, body: { slug: "acme", dayMinutes: 9999 } })).status, 401);
    assert.equal((await plane.request("GET", "/v1/admin/overview", { token })).status, 401);
    assert.equal((await plane.request("GET", "/v1/code/tasks", { token })).status, 401);
  } finally {
    await plane.dispose();
  }
});
